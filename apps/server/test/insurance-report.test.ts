import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReportSection, ReportSnapshot } from '@atlas/shared';
import { dmarcPolicy, dmarcRecord } from '../src/services/dmarc.js';
import { insuranceAnswers, type InsuranceFacts } from '../src/services/reports/insurance.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const TODAY = '2026-10-21';
const facts = (over: Partial<InsuranceFacts> = {}): InsuranceFacts => ({
  devices: { total: 20, protected: 20, current: 20, staleDays: 7 },
  encryption: { reported: 10, encrypted: 10 },
  os: { devices: 20, endOfSupport: 0 },
  backups: [{ name: 'Datto SIRIS', tested: '2026-06-01' }],
  globalAdmins: ['admin@harbor.example', 'it@harbor.example'],
  rotation: { targets: 5, failing: 0 },
  passwords: { total: 30, withIssues: 0, breached: 0 },
  dmarc: [{ domain: 'harbor.example', policy: 'reject' }],
  filtering: ['Proofpoint Essentials'],
  documents: [
    { title: 'Incident Response Plan', reviewDate: '2027-01-01' },
    { title: 'Disaster Recovery Runbook', reviewDate: null },
  ],
  ...over,
});
const answer = (rows: ReturnType<typeof insuranceAnswers>, start: string) =>
  rows.find((r) => r.question.startsWith(start))!;

describe('cyber insurance answers', () => {
  it('answers Yes only with evidence, and never counts what Atlas cannot see as Yes', () => {
    const rows = insuranceAnswers(facts(), TODAY);
    expect(rows.map((r) => r.answer)).toEqual([
      'Not evidenced', // MFA: not read
      'Yes', // protection
      'Yes', // encryption
      'Yes', // supported OS
      'Yes', // managed
      'Yes', // backups
      'Yes', // admins
      'Yes', // local admin rotation
      'Yes', // passwords
      'Yes', // DMARC
      'Yes', // incident plan
      'Yes', // continuity plan
      'Not evidenced', // training: not tracked
    ]);
    expect(rows.filter((r) => r.answer === 'Yes').every((r) => r.action === '')).toBe(true);
    expect(answer(rows, 'Is email').evidence).toBe('harbor.example: p=reject. Filtering: Proofpoint Essentials.');

    // Nothing recorded at all: gaps and "not evidenced", none of it Yes.
    const empty = insuranceAnswers(
      facts({
        devices: null,
        encryption: { reported: 0, encrypted: 0 },
        os: null,
        backups: [],
        globalAdmins: null,
        rotation: null,
        passwords: null,
        dmarc: null,
        filtering: [],
        documents: [],
      }),
      TODAY,
    );
    expect(empty.some((r) => r.answer === 'Yes')).toBe(false);
    expect(answer(empty, 'Are backups').answer).toBe('No');
    expect(answer(empty, 'Is there a written incident').answer).toBe('No');
    expect(answer(empty, 'Are local administrator').evidence).toBe(
      'Automatic rotation is shown to administrators only.',
    );
  });

  it('marks partial coverage, stale tests and plans, and too many administrators', () => {
    const rows = insuranceAnswers(
      facts({
        devices: { total: 10, protected: 9, current: 6, staleDays: 7 },
        os: { devices: 10, endOfSupport: 3 },
        backups: [
          { name: 'Datto SIRIS', tested: '2025-01-10' },
          { name: 'M365 backup', tested: null },
        ],
        globalAdmins: ['a', 'b', 'c', 'd', 'e', 'f'],
        passwords: { total: 30, withIssues: 4, breached: 1 },
        dmarc: [
          { domain: 'harbor.example', policy: 'none' },
          { domain: 'harbor-dental.example', policy: 'missing' },
        ],
        documents: [{ title: 'Cyber incident plan', reviewDate: '2026-01-01' }],
      }),
      TODAY,
    );
    expect(answer(rows, 'Is endpoint').answer).toBe('Partly');
    expect(answer(rows, 'Are devices managed').answer).toBe('No');
    expect(answer(rows, 'Are all operating').answer).toBe('No');
    expect(answer(rows, 'Are backups').answer).toBe('Partly');
    expect(answer(rows, 'Are backups').evidence).toBe(
      'Datto SIRIS: restore tested 2025-01-10; M365 backup: no restore test recorded',
    );
    expect(answer(rows, 'Are administrator').answer).toBe('No');
    expect(answer(rows, 'Are stored').answer).toBe('No');
    expect(answer(rows, 'Is email').answer).toBe('Partly');
    expect(answer(rows, 'Is email').evidence).toContain('harbor-dental.example: no DMARC record');
    expect(answer(rows, 'Is there a written incident').answer).toBe('Partly');
    expect(answer(rows, 'Is there a business continuity').answer).toBe('No');
  });

  it('reads DMARC records, and tells a missing record from a failed lookup', async () => {
    expect(dmarcPolicy('v=DMARC1; p=reject; rua=mailto:d@harbor.example')).toBe('reject');
    expect(dmarcPolicy('v=DMARC1;p=Quarantine')).toBe('quarantine');
    expect(dmarcPolicy('v=DMARC1; rua=mailto:d@harbor.example')).toBeNull();
    const asked: string[] = [];
    const resolve = async (name: string) => {
      asked.push(name);
      return [['v=spf1 -all'], ['v=DMARC1; ', 'p=none']];
    };
    expect(await dmarcRecord('harbor.example', { resolve })).toBe('v=DMARC1; p=none');
    expect(asked).toEqual(['_dmarc.harbor.example']);
    const missing = Object.assign(new Error('no record'), { code: 'ENOTFOUND' });
    expect(await dmarcRecord('x.example', { resolve: () => Promise.reject(missing) })).toBeNull();
    await expect(
      dmarcRecord('x.example', { resolve: () => new Promise(() => undefined), timeoutMs: 20 }),
    ).rejects.toThrow('in time');
  });
});

describe('cyber insurance readiness report', () => {
  let t: TestApp, owner: Browser, clientId: string;
  const lookups: string[] = [];

  beforeEach(async () => {
    t = await startApp(
      {},
      {
        dmarcLookup: async (domain) => {
          lookups.push(domain);
          if (domain === 'broken.example') throw new Error('SERVFAIL');
          return domain === 'harbor.example' ? 'v=DMARC1; p=quarantine' : null;
        },
      },
    );
    owner = (await setupOwner(t.app)).b;
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const layout = (key: string) => layouts.find((l) => l.key === key)!.id;
    const asset = async (key: string, name: string, fields: Record<string, string> = {}) => {
      const r = await owner.call('POST', `/api/clients/${clientId}/assets`, { layoutId: layout(key), name, fields });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
    };
    await asset('domain', 'harbor.example');
    await asset('domain', 'harbor-mail.example');
    await asset('domain', 'broken.example');
    await asset('backup', 'Datto SIRIS', { product: 'Datto SIRIS', last_restore_test: '2026-09-30' });
    await owner.call('POST', '/api/documents', {
      clientId,
      title: 'Harbor incident response plan',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Who to call' }] }] },
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('answers the insurer questions with evidence, lists the gaps worst first, and checks DMARC live', async () => {
    const made = await owner.call('POST', '/api/reports/runs', {
      kind: 'insurance',
      title: 'Cyber insurance readiness',
      clientIds: [clientId],
    });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const snapshot = made.data.snapshot as ReportSnapshot;
    const section = (title: string) => snapshot.sections.find((s) => s.title === title) as ReportSection;
    expect(section('Readiness summary').rows[0]![0]).toBe('Harbor Dental');

    const questions = section('Insurer questions and evidence').rows;
    const row = (start: string) => questions.find((r) => r[1]!.startsWith(start))!;
    expect(row('Are backups')[2]).toBe('Yes');
    expect(row('Is there a written incident')[2]).toBe('Yes');
    expect(row('Is there a business continuity')[2]).toBe('No');
    expect(row('Is multi-factor')[2]).toBe('Not evidenced');
    // DMARC was looked up for each domain; the one that failed is a notice, not "no record".
    expect(lookups.sort()).toEqual(['broken.example', 'harbor-mail.example', 'harbor.example']);
    expect(row('Is email')[2]).toBe('Partly');
    expect(row('Is email')[3]).toBe('harbor-mail.example: no DMARC record; harbor.example: p=quarantine.');
    expect(snapshot.warnings).toContain('Harbor Dental: DMARC for broken.example could not be looked up.');

    // Gaps: every answer that isn't Yes, refusals first, each with what to do.
    const gaps = section('Gaps to close before renewal').rows;
    expect(gaps.every((g) => g[2] !== 'Yes' && g[3]!.length > 0)).toBe(true);
    expect(gaps[0]![2]).toBe('No');
    expect(gaps.at(-1)![2]).toBe('Not evidenced');

    // Exports, including the PDF.
    const pdf = await owner.call('GET', `/api/reports/runs/${made.data.id}/export?format=pdf&whole=1`);
    expect(pdf.status).toBe(200);
  });
});
