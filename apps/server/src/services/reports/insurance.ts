import { and, eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { AssetStatsService } from '../asset-stats.js';
import { dmarcPolicy, type DmarcPolicy } from '../dmarc.js';
import { RmmHealthService } from '../rmm-health.js';
import { DAY, dateValue, newest, type Collector } from './context.js';
import { encryptionOf, passwords } from './security.js';

export type InsuranceAnswer = 'Yes' | 'Partly' | 'No' | 'Not evidenced';
/** Order of the gaps: what an insurer would refuse first. */
const SEVERITY: Record<InsuranceAnswer, number> = { No: 0, Partly: 1, 'Not evidenced': 2, Yes: 3 };

/** What one client's answers are worked out from. Null where Atlas has nothing to go on, never "fine". */
export interface InsuranceFacts {
  devices: { total: number; protected: number; current: number; staleDays: number } | null;
  /** Machines the BitLocker collector reported on, and those fully encrypted. */
  encryption: { reported: number; encrypted: number };
  os: { devices: number; endOfSupport: number } | null;
  backups: { name: string; tested: string | null }[];
  /** Global administrators of the client's Microsoft 365 tenant, or null without a synced tenant. */
  globalAdmins: string[] | null;
  /** Automatic rotation targets, or null where rotation isn't shown (it's for administrators). */
  rotation: { targets: number; failing: number } | null;
  /** Passwords in the vault, or null where this person can't open the client's passwords. */
  passwords: { total: number; withIssues: number; breached: number } | null;
  /** Each recorded domain's DMARC policy ('missing' without a record), or null when none could be looked up. */
  dmarc: { domain: string; policy: DmarcPolicy | 'missing' | 'unset' }[] | null;
  /** Mail filtering services recorded on Email assets. */
  filtering: string[];
  documents: { title: string; reviewDate: string | null }[];
}

export interface InsuranceRow {
  question: string;
  answer: InsuranceAnswer;
  evidence: string;
  source: string;
  /** What to do before renewal; empty when the answer is Yes. */
  action: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Yes when all are good, Partly when most (80%+) are, No otherwise. */
const share = (good: number, total: number): InsuranceAnswer =>
  good === total ? 'Yes' : good / total >= 0.8 ? 'Partly' : 'No';
const INCIDENT_PLAN = /\bincident\b.*\b(response|plan)\b|\bbreach response\b|\bcyber ?incident\b/i;
const CONTINUITY_PLAN = /\b(disaster recovery|business continuity|continuity plan|recovery plan)\b|\b(bcp|drp)\b/i;

/**
 * The questions cyber insurers ask, answered for one client from what Atlas holds. Each answer carries its
 * evidence and where it came from. What Atlas can't see is "Not evidenced", with what to keep for the application.
 */
export function insuranceAnswers(f: InsuranceFacts, today: string): InsuranceRow[] {
  const rows: InsuranceRow[] = [];
  const add = (question: string, answer: InsuranceAnswer, evidence: string, source: string, action = '') =>
    rows.push({ question, answer, evidence, source, action: answer === 'Yes' ? '' : action });

  add(
    'Is multi-factor authentication enforced for email and remote access?',
    'Not evidenced',
    f.globalAdmins
      ? 'The Microsoft 365 tenant is synced, but MFA enforcement is not read through GDAP.'
      : 'Atlas does not read MFA enforcement.',
    'Not tracked in Atlas',
    'Confirm MFA covers every user and all remote access (Conditional Access or Security Defaults), and keep a screenshot for the application.',
  );

  const d = f.devices;
  if (d?.total)
    add(
      'Is endpoint protection (EDR or antivirus) running on every device?',
      share(d.protected, d.total),
      `${d.protected} of ${plural(d.total, 'device')} report protection running.`,
      'ConnectWise RMM',
      `Restore protection on ${plural(d.total - d.protected, 'device')}.`,
    );
  else
    add(
      'Is endpoint protection (EDR or antivirus) running on every device?',
      'Not evidenced',
      'No devices are synced from the RMM.',
      'ConnectWise RMM',
      'Connect ConnectWise RMM, or export your EDR console’s device list.',
    );

  const e = f.encryption;
  add(
    'Are laptops and workstations encrypted?',
    e.reported ? share(e.encrypted, e.reported) : 'Not evidenced',
    e.reported
      ? `${e.encrypted} of ${plural(e.reported, 'machine')} reporting BitLocker are fully encrypted.`
      : 'No machines report BitLocker status.',
    'BitLocker collector',
    e.reported
      ? `Encrypt the ${plural(e.reported - e.encrypted, 'machine')} with a volume not protected.`
      : 'Enroll the client’s machines in the BitLocker collector, or export encryption status from your RMM.',
  );

  const os = f.os;
  add(
    'Are all operating systems still supported by their vendor?',
    os?.devices ? (os.endOfSupport ? (os.endOfSupport / os.devices <= 0.1 ? 'Partly' : 'No') : 'Yes') : 'Not evidenced',
    os?.devices
      ? os.endOfSupport
        ? `${plural(os.endOfSupport, 'device')} of ${os.devices} run an operating system past its end of support.`
        : `All ${plural(os.devices, 'device')} with a recorded operating system are supported.`
      : 'No device operating systems are recorded.',
    'Atlas assets',
    os?.devices
      ? `Upgrade or replace the ${plural(os.endOfSupport, 'device')}, or isolate them and say so on the application.`
      : 'Record operating systems on devices (the RMM sync does this).',
  );

  add(
    'Are devices managed centrally and kept up to date?',
    d?.total ? share(d.current, d.total) : 'Not evidenced',
    d?.total
      ? `${d.current} of ${plural(d.total, 'device')} checked in with the RMM within ${d.staleDays} days. Patch levels are in the RMM.`
      : 'No devices are synced from the RMM.',
    'ConnectWise RMM',
    d?.total
      ? `Bring ${plural(d.total - d.current, 'device')} back into management, and export the RMM’s patch report as evidence of patch age.`
      : 'Export your RMM’s patch compliance report for the application.',
  );

  const tested = f.backups.filter((b) => b.tested && Date.parse(b.tested) >= Date.parse(today) - 365 * DAY);
  add(
    'Are backups in place and restore-tested in the last 12 months?',
    f.backups.length ? (tested.length === f.backups.length ? 'Yes' : 'Partly') : 'No',
    f.backups.length
      ? f.backups
          .map((b) => `${b.name}: ${b.tested ? `restore tested ${b.tested}` : 'no restore test recorded'}`)
          .join('; ')
      : 'No backups are documented.',
    'Atlas assets (Backups)',
    f.backups.length
      ? 'Run a restore test of each backup and record its date on the Backups asset. Keep one copy offline or immutable.'
      : 'Document each backup (what, where, how often) as a Backups asset, with its last restore test.',
  );

  const admins = f.globalAdmins;
  add(
    'Are administrator accounts limited to the people who need them?',
    !admins?.length ? 'Not evidenced' : admins.length <= 4 ? 'Yes' : 'No',
    !admins
      ? 'No Microsoft 365 tenant is synced.'
      : `${plural(admins.length, 'Global Administrator')} in Microsoft 365${admins.length ? `: ${admins.join(', ')}` : ''}.`,
    'Microsoft 365 (GDAP sync)',
    admins?.length
      ? 'Microsoft recommends fewer than five Global Administrators. Move the rest to narrower roles.'
      : 'Link the client’s Microsoft 365 tenant, or list your administrator accounts for the application.',
  );

  const r = f.rotation;
  add(
    'Are local administrator passwords unique and rotated?',
    r?.targets ? (r.failing ? 'Partly' : 'Yes') : 'Not evidenced',
    !r
      ? 'Automatic rotation is shown to administrators only.'
      : r.targets
        ? `${plural(r.targets, 'account')} rotated automatically${r.failing ? `, ${r.failing} failing` : ''}.`
        : 'No accounts are rotated by Atlas.',
    'Automatic password rotation',
    r?.failing
      ? `Fix the ${plural(r.failing, 'failing rotation')}.`
      : 'Set up automatic rotation in Atlas, or record how Windows LAPS covers these machines.',
  );

  const p = f.passwords;
  add(
    'Are stored passwords free of known breaches and reuse?',
    !p?.total ? 'Not evidenced' : p.breached ? 'No' : p.withIssues ? 'Partly' : 'Yes',
    !p
      ? 'You can’t open this client’s passwords.'
      : !p.total
        ? 'No passwords are stored for this client.'
        : `${p.withIssues} of ${plural(p.total, 'password')} ${p.withIssues === 1 ? 'has' : 'have'} issues${p.breached ? `, ${p.breached} found in a data breach` : ''}.`,
    'Atlas password vault',
    p?.breached
      ? 'Change the breached passwords first, then the weak and reused ones (Password health lists them).'
      : 'Change the weak and reused passwords (Password health lists them).',
  );

  const mail = f.dmarc;
  const enforced = mail?.filter((m) => m.policy === 'quarantine' || m.policy === 'reject') ?? [];
  const filtered = f.filtering.length ? ` Filtering: ${f.filtering.join(', ')}.` : '';
  add(
    'Is email protected against spoofing (DMARC) and filtered?',
    !mail?.length
      ? 'Not evidenced'
      : enforced.length === mail.length
        ? 'Yes'
        : mail.some((m) => m.policy !== 'missing')
          ? 'Partly'
          : 'No',
    (mail?.length
      ? mail
          .map(
            (m) =>
              `${m.domain}: ${m.policy === 'missing' ? 'no DMARC record' : m.policy === 'unset' ? 'DMARC without a policy' : `p=${m.policy}`}`,
          )
          .join('; ') + '.'
      : 'No domains are recorded, or DNS was not checked.') + filtered,
    'DNS (DMARC), Atlas assets',
    mail?.length
      ? 'Publish DMARC with p=quarantine or p=reject on every sending domain, after SPF and DKIM pass.'
      : 'Record the client’s domains as Domains assets so their DMARC is checked.',
  );

  for (const [question, pattern, name] of [
    ['Is there a written incident response plan?', INCIDENT_PLAN, 'incident response plan'],
    ['Is there a business continuity or disaster recovery plan?', CONTINUITY_PLAN, 'continuity or recovery plan'],
  ] as const) {
    const found = f.documents.filter((doc) => pattern.test(doc.title));
    const current = found.filter((doc) => !doc.reviewDate || doc.reviewDate >= today);
    add(
      question,
      !found.length ? 'No' : current.length ? 'Yes' : 'Partly',
      found.length
        ? found
            .map((doc) => `“${doc.title}”${doc.reviewDate && doc.reviewDate < today ? ' (past its review date)' : ''}`)
            .join(', ')
        : `No document titled as an ${name} is on record.`,
      'Atlas documentation',
      found.length
        ? 'Review the plan and set its next review date.'
        : `Write the client’s ${name} in Atlas (the template library has a runbook to start from).`,
    );
  }

  add(
    'Do staff complete security awareness training?',
    'Not evidenced',
    'Atlas does not track training.',
    'Not tracked in Atlas',
    'Keep your training provider’s completion report for the application.',
  );
  return rows;
}

/** The questions cyber insurers ask, answered per client with evidence, and the gaps to close before renewal. */
export const insurance: Collector = async (report) => {
  const { scope, settings, today } = report;
  const assets = await report.assets();
  const documents = await report.documents();
  const pw = await passwords(report);

  const rmm = await new RmmHealthService(settings).report(scope);
  report.source('ConnectWise RMM', 'Endpoint protection and check-ins from the last RMM sync.', rmm.updatedAt);
  const stats = await new AssetStatsService(settings).report(scope);
  const machines = await report.db
    .select({
      clientId: schema.bitlockerDevices.clientId,
      volumes: schema.bitlockerDevices.volumes,
      collectedAt: schema.bitlockerDevices.collectedAt,
    })
    .from(schema.bitlockerDevices)
    .where(and(report.selected(schema.bitlockerDevices), eq(schema.bitlockerDevices.blocked, false)));
  report.source(
    'BitLocker collector',
    'Volume protection reported by enrolled machines. Recovery keys are excluded.',
    newest(machines.map((m) => m.collectedAt)),
  );
  // Rotation is administration: anyone else's report says so rather than failing.
  const targets = report.security
    ? await report.security
        .rotationTargets(scope)
        .then((all) => all.filter((t) => report.names.has(t.clientId)))
        .catch(() => null)
    : null;

  // DMARC for every recorded domain, looked up now. A failed lookup is a notice, never "no record".
  const lookup = report.security?.dmarc;
  const dmarc = new Map<string, { domain: string; policy: DmarcPolicy | 'missing' | 'unset' }[]>();
  if (lookup) {
    const domains = assets.filter((a) => a.layoutKey === 'domain');
    for (const a of domains.slice(0, 200)) {
      const domain = a.name.trim().toLowerCase();
      try {
        const record = await lookup(domain);
        const list = dmarc.get(a.clientId) ?? [];
        list.push({ domain, policy: record ? (dmarcPolicy(record) ?? 'unset') : 'missing' });
        dmarc.set(a.clientId, list);
      } catch {
        report.warn(`${report.client(a.clientId)}: DMARC for ${domain} could not be looked up.`);
      }
    }
    if (domains.length)
      report.source('DNS (DMARC)', 'Each recorded domain’s DMARC record, looked up when the report ran.');
  } else report.warn('DMARC records were not looked up, so email spoofing protection is not evidenced.');

  const answers = new Map(
    report.clients.map((c) => {
      const mine = assets.filter((a) => a.clientId === c.id);
      const devices = rmm.clients.find((r) => r.clientId === c.id)?.counts;
      const os = stats.clients.find((s) => s.clientId === c.id);
      const encryption = machines.filter((m) => m.clientId === c.id && encryptionOf(m.volumes) !== 'Unknown');
      const tenant = mine.find((a) => a.layoutKey === 'm365_tenant');
      const field = (fields: unknown, key: string) => {
        const value = (fields as Record<string, unknown>)[key];
        return typeof value === 'string' ? value.trim() : '';
      };
      const pwTotals = pw.totals.get(c.id);
      const facts: InsuranceFacts = {
        devices: devices
          ? {
              total: devices.total,
              protected: devices.protectionRunning,
              current: devices.current,
              staleDays: rmm.staleDays,
            }
          : null,
        encryption: {
          reported: encryption.length,
          encrypted: encryption.filter((m) => encryptionOf(m.volumes) === 'Encrypted').length,
        },
        os: os ? { devices: os.counts.total, endOfSupport: os.endOfSupport } : null,
        backups: mine
          .filter((a) => a.layoutKey === 'backup')
          .map((a) => {
            const date = field(a.fields, 'last_restore_test');
            return { name: a.name, tested: dateValue(date) ? date : null };
          }),
        globalAdmins: tenant ? field(tenant.fields, 'global_admins').split('\n').filter(Boolean) : null,
        rotation: targets
          ? {
              targets: targets.filter((t) => t.clientId === c.id && t.enabled && t.policyId).length,
              failing: targets.filter((t) => t.clientId === c.id && t.lastStatus === 'failed').length,
            }
          : null,
        passwords: pw.vaultIds.has(c.id)
          ? {
              total: pwTotals?.total ?? 0,
              withIssues: pwTotals?.withIssues ?? 0,
              breached: pw.issues.filter((i) => i.clientId === c.id && i.issues.includes('breached')).length,
            }
          : null,
        dmarc: dmarc.get(c.id) ?? null,
        filtering: mine
          .filter((a) => a.layoutKey === 'email')
          .map((a) => field(a.fields, 'filtering'))
          .filter(Boolean),
        documents: documents.filter((doc) => doc.clientId === c.id),
      };
      return [c.id, insuranceAnswers(facts, today)] as const;
    }),
  );

  report.section(
    'Readiness summary',
    ['Client', 'Ready', 'Yes', 'Partly', 'No', 'Not evidenced'],
    report.clients.map((c) => {
      const rows = answers.get(c.id)!;
      const n = (answer: InsuranceAnswer) => rows.filter((r) => r.answer === answer).length;
      const answered = n('Yes') + n('Partly') + n('No');
      return [
        c.name,
        answered ? `${Math.round(((n('Yes') + n('Partly') / 2) / answered) * 100)}%` : 'Not available',
        String(n('Yes')),
        String(n('Partly')),
        String(n('No')),
        String(n('Not evidenced')),
      ];
    }),
  );
  report.section(
    'Gaps to close before renewal',
    ['Client', 'Question', 'Answer', 'What to do'],
    report.clients.flatMap((c) =>
      answers
        .get(c.id)!
        .filter((r) => r.answer !== 'Yes')
        .sort((a, b) => SEVERITY[a.answer] - SEVERITY[b.answer])
        .map((r) => [c.name, r.question, r.answer, r.action]),
    ),
  );
  report.section(
    'Insurer questions and evidence',
    ['Client', 'Question', 'Answer', 'Evidence', 'Source'],
    report.clients.flatMap((c) => answers.get(c.id)!.map((r) => [c.name, r.question, r.answer, r.evidence, r.source])),
  );
  report.warn(
    'Answers come from the records in Atlas. "Not evidenced" means Atlas holds no proof either way: answer it from your own records, not as a Yes.',
  );
};
