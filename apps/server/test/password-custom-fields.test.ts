import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

type Field = { id: string; label: string; secret: boolean; value: string | null };

describe('password custom fields', () => {
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

  it('stores plain and secret fields, and hides secret values until revealed', async () => {
    const created = await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      name: 'Tenant admin',
      secret: 'Tr0ub4dor&3-Harbor!',
      customFields: [
        { label: 'Tenant ID', value: 'harbordental.onmicrosoft.com' },
        { label: 'Break-glass PIN', value: '8841-2290', secret: true },
      ],
    });
    expect(created.status).toBe(201);
    const fields = created.data.customFields as Field[];
    expect(fields).toMatchObject([
      { label: 'Tenant ID', secret: false, value: 'harbordental.onmicrosoft.com' },
      { label: 'Break-glass PIN', secret: true, value: null },
    ]);

    // Encrypted at rest.
    const raw = await t.handle.db.execute(sql`select custom_fields::text as f from passwords`);
    expect(JSON.stringify(raw.rows)).not.toContain('8841-2290');

    const pin = fields[1]!;
    const revealed = await owner.call('POST', `/api/passwords/${created.data.id}/reveal`, {
      field: 'custom',
      fieldId: pin.id,
    });
    expect(revealed.data.value).toBe('8841-2290');
    const audit = (await owner.call('GET', `/api/passwords/${created.data.id}/audit`)).data as { action: string }[];
    expect(audit.map((a) => a.action)).toContain('Viewed custom field “Break-glass PIN”');
  });

  it('keeps an unchanged secret on edit, and needs a value for new ones', async () => {
    const pw = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, {
        name: 'Tenant admin',
        secret: 'Tr0ub4dor&3-Harbor!',
        customFields: [{ label: 'PIN', value: '1234', secret: true }],
      })
    ).data;
    const pin = pw.customFields[0] as Field;

    const edited = await owner.call('PATCH', `/api/passwords/${pw.id}`, {
      version: pw.version,
      customFields: [
        { id: pin.id, label: 'Recovery PIN', secret: true },
        { label: 'Portal', value: 'https://admin.microsoft.com' },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.data.customFields).toMatchObject([
      { id: pin.id, label: 'Recovery PIN', secret: true, value: null },
      { label: 'Portal', value: 'https://admin.microsoft.com' },
    ]);
    const again = await owner.call('POST', `/api/passwords/${pw.id}/reveal`, { field: 'custom', fieldId: pin.id });
    expect(again.data.value).toBe('1234');

    const missing = await owner.call('PATCH', `/api/passwords/${pw.id}`, {
      version: edited.data.version,
      customFields: [{ label: 'New secret', secret: true }],
    });
    expect(missing.status).toBe(400);

    // Another password's field id can't be borrowed.
    const other = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Other', secret: 'Tr0ub4dor&3-Other!' })
    ).data;
    expect(
      (
        await owner.call('PATCH', `/api/passwords/${other.id}`, {
          version: other.version,
          customFields: [{ id: pin.id, label: 'Stolen', secret: true }],
        })
      ).status,
    ).toBe(400);
  });
});
