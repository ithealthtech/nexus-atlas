import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

type Run = {
  id: string;
  title: string;
  steps: { id: string; text: string; doneAt: string | null; doneByName: string | null; note: string }[];
  done: number;
  total: number;
  completedAt: string | null;
  assigneeName: string | null;
  canEdit: boolean;
};

describe('checklists', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let northline: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  async function person(email: string, next: string, body: Record<string, unknown>, staff = false) {
    // A new password may not contain the person's name, so tests use unrelated words.
    const created = await owner.call('POST', '/api/users', {
      email,
      name: email.split('@')[0],
      password: TEMP,
      ...body,
    });
    expect(created.status).toBe(201);
    const { b } = await signIn(t.app, email, TEMP);
    const changed = await b.call('POST', '/api/account/password', { current: TEMP, next });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    if (staff) await enroll(b);
    return { b, id: created.data.id as string };
  }

  it('runs an MSP checklist for a client, records who ticked each step, and completes when all are done', async () => {
    const template = await owner.call('POST', '/api/checklists', {
      title: 'New user onboarding',
      steps: [
        { text: 'Create the Microsoft 365 account' },
        { text: 'Add to the right groups' },
        { text: 'Set up MFA' },
      ],
    });
    expect(template.status).toBe(201);
    expect(template.data.clientId).toBeNull();
    expect(
      (await owner.call('POST', '/api/checklists', { title: 'Empty', steps: [] })).data.fields?.steps,
    ).toBeTruthy();

    const tech = await person(
      'tech@msp.test',
      'cobalt fresh pass 12',
      { role: 'technician', allClients: 'edit' },
      true,
    );
    const started = await owner.call('POST', `/api/clients/${harbor}/checklist-runs`, {
      checklistId: template.data.id,
      assigneeId: tech.id,
      dueDate: '2026-10-31',
    });
    expect(started.status).toBe(201);
    let run = started.data as Run;
    expect(run).toMatchObject({ title: 'New user onboarding', done: 0, total: 3, assigneeName: 'tech' });

    // Later edits to the template don't change a run already under way.
    await owner.call('PATCH', `/api/checklists/${template.data.id}`, { steps: [{ text: 'Only step' }] });
    run = (await tech.b.call('GET', `/api/checklist-runs/${run.id}`)).data;
    expect(run.total).toBe(3);

    for (const step of run.steps.slice(0, 2))
      run = (await tech.b.call('POST', `/api/checklist-runs/${run.id}/steps/${step.id}`, { done: true })).data;
    expect(run.done).toBe(2);
    expect(run.steps[0]!.doneByName).toBe('tech');
    expect(run.completedAt).toBeNull();
    expect((await tech.b.call('GET', '/api/checklist-runs?assignee=me&state=open')).data.map((r: Run) => r.id)).toEqual(
      [run.id],
    );

    run = (
      await owner.call('POST', `/api/checklist-runs/${run.id}/steps/${run.steps[2]!.id}`, {
        done: true,
        note: 'Authenticator app',
      })
    ).data;
    expect(run.completedAt).not.toBeNull();
    expect(run.steps[2]).toMatchObject({ doneByName: 'Avery Owner', note: 'Authenticator app' });
    expect((await tech.b.call('GET', '/api/checklist-runs?assignee=me&state=open')).data).toHaveLength(0);

    // Unticking reopens it.
    run = (await owner.call('POST', `/api/checklist-runs/${run.id}/steps/${run.steps[0]!.id}`, { done: false })).data;
    expect(run.completedAt).toBeNull();
    expect(run.steps[0]!.doneByName).toBeNull();

    const md = await owner.call('GET', `/api/checklist-runs/${run.id}/markdown`);
    expect(md.headers['content-type']).toContain('text/markdown');
    expect(String(md.data)).toContain('# New user onboarding');
    expect(String(md.data)).toContain('- [ ] Create the Microsoft 365 account');
    expect(String(md.data)).toContain('- [x] Set up MFA — Avery Owner');
    expect(String(md.data)).toContain('  - Note: Authenticator app');
  });

  it('keeps client checklists with their client and follows client access', async () => {
    const harborOnly = (
      await owner.call('POST', '/api/checklists', {
        title: 'Harbor badge reset',
        clientId: harbor,
        steps: [{ text: 'x' }],
      })
    ).data;
    // A client's checklist can't be run for another client.
    expect(
      (await owner.call('POST', `/api/clients/${northline}/checklist-runs`, { checklistId: harborOnly.id })).status,
    ).toBe(400);
    const oneOff = await owner.call('POST', `/api/clients/${harbor}/checklist-runs`, {
      title: 'Printer move',
      steps: ['Unplug', 'Move', 'Test print'],
    });
    expect(oneOff.data.total).toBe(3);

    // Read-only access: sees the run, can't tick it or start one.
    const reader = await person(
      'reader@msp.test',
      'amber quiet lake 47',
      { role: 'readonly_technician', grants: [{ clientId: harbor, level: 'read' }] },
      true,
    );
    const seen = (await reader.b.call('GET', `/api/checklist-runs/${oneOff.data.id}`)).data as Run;
    expect(seen.canEdit).toBe(false);
    expect(
      (await reader.b.call('POST', `/api/checklist-runs/${seen.id}/steps/${seen.steps[0]!.id}`, { done: true })).status,
    ).toBe(403);
    expect(
      (await reader.b.call('POST', `/api/clients/${harbor}/checklist-runs`, { title: 'x', steps: ['y'] })).status,
    ).toBe(403);
    // No access to Northline: its checklists and runs don't exist for them.
    const northRun = (
      await owner.call('POST', `/api/clients/${northline}/checklist-runs`, { title: 'Firewall review', steps: ['a'] })
    ).data;
    expect((await reader.b.call('GET', `/api/checklist-runs/${northRun.id}`)).status).toBe(404);
    expect((await reader.b.call('GET', '/api/checklist-runs')).data.map((r: Run) => r.title)).toEqual(['Printer move']);
    expect(
      (await reader.b.call('GET', `/api/checklists?client=${harbor}`)).data.map((c: { title: string }) => c.title),
    ).toEqual(['Harbor badge reset']);

    // Archived checklists aren't offered and can't be started.
    await owner.call('POST', `/api/checklists/${harborOnly.id}/archive`, { archived: true });
    expect((await owner.call('GET', `/api/checklists?client=${harbor}`)).data).toHaveLength(0);
    expect(
      (await owner.call('POST', `/api/clients/${harbor}/checklist-runs`, { checklistId: harborOnly.id })).status,
    ).toBe(400);
    // …but they're listed as archived and can be restored.
    const archivedList = (await owner.call('GET', `/api/checklists?client=${harbor}&archived=true`)).data;
    expect(archivedList.map((c: { title: string }) => c.title)).toEqual(['Harbor badge reset']);
    await owner.call('POST', `/api/checklists/${harborOnly.id}/archive`, { archived: false });
    expect((await owner.call('GET', `/api/checklists?client=${harbor}`)).data).toHaveLength(1);
    await owner.call('POST', `/api/checklists/${harborOnly.id}/archive`, { archived: true });

    // Only someone on the team can be assigned.
    const contact = await person('viewer@harbor.test', 'maple north orbit 9', {
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect(
      (await owner.call('PATCH', `/api/checklist-runs/${oneOff.data.id}`, { assigneeId: contact.id })).status,
    ).toBe(400);

    // The team for a client is the staff who can edit it: not the read-only reader, and not a technician who
    // only has Northline.
    const northTech = await person(
      'north@msp.test',
      'granite slow river 8',
      { role: 'technician', grants: [{ clientId: northline, level: 'edit' }] },
      true,
    );
    const team = async (client: string) =>
      (await owner.call('GET', `/api/checklists/team?client=${client}`)).data.map((u: { name: string }) => u.name);
    expect(await team(harbor)).toEqual(['Avery Owner']);
    expect(await team(northline)).toEqual(['Avery Owner', 'north']);
    expect(
      (await owner.call('PATCH', `/api/checklist-runs/${oneOff.data.id}`, { assigneeId: northTech.id })).status,
    ).toBe(400);
    expect(
      (
        await owner.call('POST', `/api/clients/${harbor}/checklist-runs`, {
          title: 'x',
          steps: ['y'],
          assigneeId: northTech.id,
        })
      ).status,
    ).toBe(400);
    expect((await owner.call('PATCH', `/api/checklist-runs/${northRun.id}`, { assigneeId: northTech.id })).status).toBe(
      200,
    );
    expect((await contact.b.call('GET', `/api/checklists/team?client=${harbor}`)).status).toBe(403);
    expect((await owner.call('GET', '/api/checklists/team')).status).toBe(404);

    expect((await owner.call('DELETE', `/api/checklist-runs/${oneOff.data.id}`)).status).toBe(200);
    expect((await owner.call('GET', `/api/checklist-runs/${oneOff.data.id}`)).status).toBe(404);
  });

  it('handles many ticks at once without running out of database connections', async () => {
    const run = (
      await owner.call('POST', `/api/clients/${harbor}/checklist-runs`, {
        title: 'Rack audit',
        steps: Array.from({ length: 8 }, (_, i) => `Shelf ${i + 1}`),
      })
    ).data as Run;
    // More ticks than the pool has connections (5 in tests), all on the same run.
    const ticks = Promise.all(
      run.steps.map((s) => owner.call('POST', `/api/checklist-runs/${run.id}/steps/${s.id}`, { done: true })),
    );
    const timeout = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 10_000));
    const result = await Promise.race([ticks, timeout]);
    expect(result).not.toBe('hung');
    expect((result as { status: number }[]).every((r) => r.status === 200)).toBe(true);
    const after = (await owner.call('GET', `/api/checklist-runs/${run.id}`)).data as Run;
    expect(after.done).toBe(8);
    expect(after.completedAt).not.toBeNull();
  });
  it('adds the built-in checklists and runbooks once, as editable copies', async () => {
    type Template = { key: string; kind: string; title: string; addedId: string | null };
    const library = (await owner.call('GET', '/api/templates')).data as Template[];
    expect(library.some((t) => t.kind === 'checklist')).toBe(true);
    expect(library.some((t) => t.kind === 'runbook')).toBe(true);
    expect(library.every((t) => t.addedId === null)).toBe(true);

    const one = await owner.call('POST', '/api/templates', { keys: ['user-offboarding'] });
    expect(one.status).toBe(200);
    const offboarding = (one.data as Template[]).find((t) => t.key === 'user-offboarding')!;
    expect(offboarding.addedId).not.toBeNull();
    // A renamed copy still counts as added, so adding everything doesn't bring it back.
    await owner.call('PATCH', `/api/checklists/${offboarding.addedId}`, { title: 'Leaver' });

    const all = (await owner.call('POST', '/api/templates', {})).data as Template[];
    expect(all.every((t) => t.addedId)).toBe(true);
    expect((await owner.call('POST', '/api/templates', {})).status).toBe(200);
    const checklists = (await owner.call('GET', '/api/checklists?client=global')).data as { title: string }[];
    expect(checklists).toHaveLength(library.filter((t) => t.kind === 'checklist').length);
    expect(checklists.some((c) => c.title === 'Leaver')).toBe(true);

    const folders = (await owner.call('GET', '/api/folders')).data as { name: string; documentCount: number }[];
    expect(folders).toEqual([
      expect.objectContaining({ name: 'Runbooks', documentCount: library.filter((t) => t.kind === 'runbook').length }),
    ]);
    const runbook = all.find((t) => t.kind === 'runbook')!;
    const doc = (await owner.call('GET', `/api/documents/${runbook.addedId}`)).data;
    expect(doc.title).toBe(runbook.title);
    expect(doc.content.content.length).toBeGreaterThan(2);

    // A run started from a library checklist works like any other.
    const run = await owner.call('POST', `/api/clients/${harbor}/checklist-runs`, { checklistId: offboarding.addedId });
    expect(run.status).toBe(201);
  });

  it('keeps the template library to staff who can edit the knowledge base', async () => {
    const contact = await person('front@harbor.test', 'quiet orchard lantern 7', {
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect((await contact.b.call('GET', '/api/templates')).status).toBe(403);
    expect((await contact.b.call('POST', '/api/templates', {})).status).toBe(404);
  });
});
