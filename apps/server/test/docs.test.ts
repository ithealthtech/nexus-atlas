import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanRichText } from '../src/services/richtext.js';
import { prefixQuery } from '../src/services/search.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function multipart(filename: string, body: Buffer, contentType = 'application/octet-stream') {
  const boundary = '----atlas' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('rich text and search helpers', () => {
  it('keeps allowed formatting, extracts text, and rejects unsafe content', () => {
    const { content, text } = cleanRichText({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2, onclick: 'x' }, content: [{ type: 'text', text: 'Restore' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check backups' }] }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Portal',
              marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(content)).not.toContain('onclick');
    expect(JSON.stringify(content)).not.toContain('_blank');
    expect(text).toBe('Restore\n[x] Check backups\nPortal');
    expect(() => cleanRichText({ type: 'doc', content: [{ type: 'script', content: [] }] })).toThrow(/Unsupported/);
    expect(() =>
      cleanRichText(
        doc('x') && {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
            },
          ],
        },
      ),
    ).toThrow(/Links must/);
    expect(() =>
      cleanRichText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '//evil.example' } }] }],
          },
        ],
      }),
    ).toThrow();
  });
  it('builds prefix queries from free text', () => {
    expect(prefixQuery("Harb fire'wall")).toBe("'harb':* & 'fire':* & 'wall':*");
    expect(prefixQuery('10.20.0.1')).toBe("'10.20.0.1':*");
    expect(prefixQuery('  --  ')).toBeNull();
  });
});

describe('documentation', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let northline: string;
  let layoutId: (key: string) => string;

  beforeEach(async () => {
    t = await startApp({
      ATLAS_MAX_UPLOAD_MB: '1',
      ATLAS_DATA_DIR: `test-results/data-${Math.random().toString(36).slice(2)}`,
    });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    layoutId = (key) => layouts.find((l) => l.key === key)!.id;
  });
  afterEach(async () => {
    await t.close();
  });

  async function person(email: string, next: string, body: Record<string, unknown>, staff = false) {
    expect(
      (await owner.call('POST', '/api/users', { email, name: email.split('@')[0], password: TEMP, ...body })).status,
    ).toBe(201);
    const { b } = await signIn(t.app, email, TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next });
    if (staff) await enroll(b);
    return b;
  }

  it('seeds built-in layouts and lets only admins define new ones', async () => {
    const layouts = (await owner.call('GET', '/api/layouts')).data;
    expect(layouts).toHaveLength(13);
    expect(layouts.map((l: { key: string }) => l.key)).toContain('ssl_certificate');
    const created = await owner.call('POST', '/api/layouts', {
      name: 'Door access',
      icon: 'key-round',
      fields: [
        { key: 'panel', label: 'Panel', type: 'text', required: true },
        { key: 'mode', label: 'Mode', type: 'select', options: ['Card', 'PIN'] },
      ],
    });
    expect(created.status).toBe(201);
    expect(
      (await owner.call('POST', '/api/layouts', { name: 'Bad', fields: [{ key: 'a', label: 'A', type: 'select' }] }))
        .status,
    ).toBe(400);
    expect(
      (
        await owner.call('POST', '/api/layouts', {
          name: 'Dup',
          fields: [
            { key: 'a', label: 'A', type: 'text' },
            { key: 'a', label: 'B', type: 'text' },
          ],
        })
      ).status,
    ).toBe(400);
    const tech = await person(
      'tech@atlas.test',
      'blue fresh pass 11',
      { role: 'technician', allClients: 'edit' },
      true,
    );
    expect((await tech.call('POST', '/api/layouts', { name: 'Nope', fields: [] })).status).toBe(403);
    expect((await tech.call('GET', '/api/layouts')).data).toHaveLength(14);
  });

  it('validates asset fields, versions changes, and restores revisions', async () => {
    const bad = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: layoutId('configuration'),
      name: 'HDG-FW-01',
      fields: { ip_address: '10.20.0.999', type: 'Toaster' },
    });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.data.fields)).toEqual(expect.arrayContaining(['fields.ip_address', 'fields.type']));
    expect(
      (
        await owner.call('POST', `/api/clients/${harbor}/assets`, {
          layoutId: layoutId('network'),
          name: 'LAN',
          fields: {},
        })
      ).data.fields['fields.subnet'],
    ).toMatch(/required/);
    const created = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: layoutId('configuration'),
      name: 'HDG-FW-01',
      fields: {
        type: 'Firewall',
        ip_address: '10.20.0.1',
        management_url: 'https://10.20.0.1',
        warranty_expires: '2027-03-01',
        unknown_field: 'dropped',
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.fields).toEqual({
      type: 'Firewall',
      ip_address: '10.20.0.1',
      management_url: 'https://10.20.0.1',
      warranty_expires: '2027-03-01',
    });
    const id = created.data.id;
    const v2 = await owner.call('PATCH', `/api/assets/${id}`, {
      version: 1,
      notes: 'Replaced power supply',
      fields: { ...created.data.fields, hostname: 'hdg-fw-01' },
    });
    expect(v2.data.version).toBe(2);
    expect((await owner.call('PATCH', `/api/assets/${id}`, { version: 1, name: 'stale' })).status).toBe(409);
    expect(
      (await owner.call('GET', `/api/assets/${id}/revisions`)).data.map((r: { version: number }) => r.version),
    ).toEqual([2, 1]);
    const restored = await owner.call('POST', `/api/assets/${id}/restore`, { version: 1, expectedVersion: 2 });
    expect(restored.data.version).toBe(3);
    expect(restored.data.notes).toBe('');
    expect(restored.data.fields.hostname).toBeUndefined();
    await owner.call('POST', `/api/assets/${id}/archive`, { archived: true });
    expect((await owner.call('GET', `/api/assets?client=${harbor}`)).data).toHaveLength(0);
    expect((await owner.call('GET', `/api/assets?client=${harbor}&archived=true`)).data).toHaveLength(1);
  });

  it('scopes assets, documents, contacts, and the MSP knowledge base by access', async () => {
    const hAsset = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: layoutId('domain'),
        name: 'harbordental.example',
      })
    ).data;
    const nAsset = (
      await owner.call('POST', `/api/clients/${northline}/assets`, {
        layoutId: layoutId('domain'),
        name: 'northline.example',
      })
    ).data;
    const kb = (
      await owner.call('POST', '/api/documents', {
        title: 'MSP onboarding standard',
        content: doc('Internal procedure'),
      })
    ).data;
    const hDoc = (
      await owner.call('POST', '/api/documents', {
        clientId: harbor,
        title: 'Harbor outage runbook',
        content: doc('Call the carrier'),
      })
    ).data;
    await owner.call('POST', `/api/clients/${harbor}/contacts`, {
      name: 'Morgan Ellis',
      email: 'morgan@harbor.test',
      primary: true,
    });
    const second = await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Sam Lee', primary: true });
    const contacts = (await owner.call('GET', `/api/clients/${harbor}/contacts`)).data;
    expect(contacts.filter((c: { primary: boolean }) => c.primary).map((c: { id: string }) => c.id)).toEqual([
      second.data.id,
    ]);

    const viewer = await person('viewer@harbor.test', 'reader pass for harbor', {
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect((await viewer.call('GET', '/api/assets')).data.map((a: { id: string }) => a.id)).toEqual([hAsset.id]);
    expect((await viewer.call('GET', `/api/assets/${nAsset.id}`)).status).toBe(404);
    expect((await viewer.call('GET', `/api/documents/${kb.id}`)).status).toBe(404);
    expect((await viewer.call('GET', '/api/documents?client=global')).data).toEqual([]);
    const readable = await viewer.call('GET', `/api/documents/${hDoc.id}`);
    expect(readable.data.canEdit).toBe(false);
    expect((await viewer.call('PATCH', `/api/documents/${hDoc.id}`, { version: 1, title: 'x' })).status).toBe(403);
    expect(
      (await viewer.call('POST', `/api/clients/${harbor}/assets`, { layoutId: layoutId('domain'), name: 'x' })).status,
    ).toBe(403);
    expect((await viewer.call('GET', `/api/clients/${northline}/contacts`)).status).toBe(404);
    expect(
      (await viewer.call('GET', '/api/activity')).data.every((a: { clientId: string }) => a.clientId === harbor),
    ).toBe(true);

    const readonlyTech = await person(
      'ro@atlas.test',
      'reading tech pass 1',
      { role: 'readonly_technician', allClients: 'read' },
      true,
    );
    expect((await readonlyTech.call('GET', `/api/documents/${kb.id}`)).data.canEdit).toBe(false);
    expect((await readonlyTech.call('POST', '/api/documents', { title: 'x', content: doc('x') })).status).toBe(403);
    const tech = await person(
      'tech@atlas.test',
      'blue fresh pass 11',
      { role: 'technician', grants: [{ clientId: harbor, level: 'edit' }] },
      true,
    );
    expect((await tech.call('POST', '/api/documents', { title: 'Tech SOP', content: doc('Steps') })).status).toBe(201);
    expect(
      (await tech.call('POST', '/api/documents', { clientId: northline, title: 'x', content: doc('x') })).status,
    ).toBe(404);
  });

  it('documents: sanitized content, conflicts, folders, and revision restore', async () => {
    expect(
      (
        await owner.call('POST', '/api/documents', {
          title: 'Bad',
          content: { type: 'doc', content: [{ type: 'iframe' }] },
        })
      ).status,
    ).toBe(400);
    const folder = (await owner.call('POST', '/api/folders', { clientId: harbor, name: 'Runbooks' })).data;
    expect(
      (await owner.call('POST', '/api/documents', { title: 'Wrong folder', folderId: folder.id, content: doc('x') }))
        .status,
    ).toBe(400);
    const created = (
      await owner.call('POST', '/api/documents', {
        clientId: harbor,
        folderId: folder.id,
        title: 'Firewall reboot',
        content: doc('Step one'),
        status: 'draft',
      })
    ).data;
    const edited = await owner.call('PATCH', `/api/documents/${created.id}`, {
      version: 1,
      content: doc('Step one, then two'),
      status: 'current',
      reviewDate: '2026-12-01',
    });
    expect(edited.data.version).toBe(2);
    expect((await owner.call('PATCH', `/api/documents/${created.id}`, { version: 1, title: 'stale' })).status).toBe(
      409,
    );
    expect((await owner.call('GET', `/api/documents/${created.id}/revisions/1`)).data.text).toBe('Step one');
    const restored = await owner.call('POST', `/api/documents/${created.id}/restore`, {
      version: 1,
      expectedVersion: 2,
    });
    expect(restored.data.version).toBe(3);
    expect(restored.data.status).toBe('draft');
    expect((await owner.call('GET', `/api/folders?client=${harbor}`)).data[0].documentCount).toBe(1);
    await owner.call('DELETE', `/api/folders/${folder.id}`);
    expect((await owner.call('GET', `/api/documents/${created.id}`)).data.folderId).toBeNull();
  });

  it('links items within a client, and MSP articles to client items', async () => {
    const asset = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: layoutId('configuration'),
        name: 'HDG-FW-01',
      })
    ).data;
    const runbook = (
      await owner.call('POST', '/api/documents', { clientId: harbor, title: 'WAN outage', content: doc('x') })
    ).data;
    const other = (
      await owner.call('POST', `/api/clients/${northline}/assets`, {
        layoutId: layoutId('configuration'),
        name: 'NLA-FW',
      })
    ).data;
    const kb = (await owner.call('POST', '/api/documents', { title: 'Firewall standard', content: doc('x') })).data;
    const linked = await owner.call('POST', `/api/items/asset/${asset.id}/relations`, {
      type: 'document',
      id: runbook.id,
    });
    expect(linked.data.map((r: { title: string }) => r.title)).toEqual(['WAN outage']);
    await owner.call('POST', `/api/items/asset/${asset.id}/relations`, { type: 'document', id: runbook.id });
    expect((await owner.call('GET', `/api/items/document/${runbook.id}/relations`)).data).toHaveLength(1);
    expect(
      (await owner.call('POST', `/api/items/asset/${asset.id}/relations`, { type: 'asset', id: other.id })).status,
    ).toBe(400);
    expect(
      (await owner.call('POST', `/api/items/asset/${asset.id}/relations`, { type: 'asset', id: asset.id })).status,
    ).toBe(400);
    expect(
      (await owner.call('POST', `/api/items/document/${kb.id}/relations`, { type: 'asset', id: asset.id })).status,
    ).toBe(200);
    // A client viewer sees the runbook link but not the MSP-internal article linked to the same asset.
    const viewer = await person('viewer@harbor.test', 'reader pass for harbor', {
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect(
      (await viewer.call('GET', `/api/items/asset/${asset.id}/relations`)).data.map((r: { title: string }) => r.title),
    ).toEqual(['WAN outage']);
    const relationId = linked.data[0].relationId;
    expect((await viewer.call('DELETE', `/api/items/asset/${asset.id}/relations/${relationId}`)).status).toBe(403);
    expect((await owner.call('DELETE', `/api/items/asset/${asset.id}/relations/${relationId}`)).status).toBe(200);
    expect((await owner.call('GET', `/api/items/asset/${asset.id}/relations`)).data).toHaveLength(1);
  });

  it('stores attachments safely and follows the item’s access', async () => {
    const asset = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: layoutId('configuration'),
        name: 'HDG-SRV',
      })
    ).data;
    const upload = (name: string, body: Buffer, b = owner, type = 'asset', id = asset.id) => {
      const form = multipart(name, body, 'text/html');
      return t.app.inject({
        method: 'POST',
        url: `/api/items/${type}/${id}/attachments`,
        payload: form.payload,
        headers: { ...form.headers, cookie: b.cookie, 'x-csrf-token': b.csrf },
      });
    };
    const html = await upload('../../evil<script>.html', Buffer.from('<script>alert(1)</script>'));
    expect(html.statusCode).toBe(201);
    const [file] = JSON.parse(html.body);
    // The multipart parser drops path components; the name is stored and shown only as text.
    expect(file.filename).toBe('evil<script>.html');
    expect(file.contentType).toBe('application/octet-stream');
    const png = JSON.parse((await upload('diagram.png', PNG)).body).find(
      (f: { filename: string }) => f.filename === 'diagram.png',
    );
    expect(png.previewable).toBe(true);
    expect((await upload('big.bin', Buffer.alloc(1024 * 1024 + 10))).statusCode).toBe(413);
    expect((await upload('empty.txt', Buffer.alloc(0))).statusCode).toBe(400);

    const download = await t.app.inject({
      method: 'GET',
      url: `/api/attachments/${file.id}/content?inline=1`,
      headers: { cookie: owner.cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    expect(download.headers['content-security-policy']).toContain('sandbox');
    expect(download.body).toBe('<script>alert(1)</script>');
    const image = await t.app.inject({
      method: 'GET',
      url: `/api/attachments/${png.id}/content?inline=1`,
      headers: { cookie: owner.cookie },
    });
    expect(image.headers['content-disposition']).toMatch(/^inline;/);

    const viewer = await person('viewer@harbor.test', 'reader pass for harbor', {
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/attachments/${file.id}/content`,
          headers: { cookie: viewer.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect((await upload('x.txt', Buffer.from('x'), viewer)).statusCode).toBe(403);
    expect((await viewer.call('DELETE', `/api/attachments/${file.id}`)).status).toBe(403);
    const outsider = await person('nla@north.test', 'northline reader pass', {
      role: 'client_viewer',
      grants: [{ clientId: northline, level: 'read' }],
    });
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/attachments/${file.id}/content`,
          headers: { cookie: outsider.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect((await owner.call('DELETE', `/api/attachments/${file.id}`)).status).toBe(200);
    expect((await owner.call('GET', `/api/items/asset/${asset.id}/attachments`)).data).toHaveLength(1);
  });

  it('searches across item types with prefixes and fuzzy names, within access', async () => {
    await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: layoutId('configuration'),
      name: 'HDG-FW-01',
      fields: { ip_address: '10.20.0.1', type: 'Firewall' },
    });
    await owner.call('POST', `/api/clients/${northline}/assets`, {
      layoutId: layoutId('configuration'),
      name: 'NLA-FW-01',
      fields: { type: 'Firewall' },
    });
    await owner.call('POST', '/api/documents', {
      clientId: harbor,
      title: 'Internet outage response',
      content: doc('Confirm the fiber circuit with the carrier before rebooting.'),
    });
    await owner.call('POST', '/api/documents', {
      title: 'Firewall hardening standard',
      content: doc('Disable unused services'),
    });
    await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Morgan Ellis', email: 'morgan@harbor.test' });
    const q = async (b: Browser, text: string) =>
      (await b.call('GET', `/api/search?q=${encodeURIComponent(text)}`)).data as {
        type: string;
        title: string;
        snippet: string;
      }[];
    expect((await q(owner, 'firew')).map((r) => r.title)).toEqual(
      expect.arrayContaining(['HDG-FW-01', 'NLA-FW-01', 'Firewall hardening standard']),
    );
    expect((await q(owner, '10.20.0.1'))[0]!.title).toBe('HDG-FW-01');
    const carrier = await q(owner, 'carri');
    expect(carrier[0]!.title).toBe('Internet outage response');
    expect(carrier[0]!.snippet).toContain('carrier');
    expect((await q(owner, 'morg'))[0]!.type).toBe('contact');
    expect((await q(owner, 'harbor dent')).some((r) => r.type === 'client')).toBe(true);
    const viewer = await person('viewer@harbor.test', 'reader pass for harbor', {
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect((await q(viewer, 'firew')).map((r) => r.title)).toEqual(['HDG-FW-01']);
    expect(await q(viewer, "'; drop table users; --")).toEqual([]);
  });
});
