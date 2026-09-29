import { createHash } from 'node:crypto';
import type { Database } from '@atlas/db';
import { PASSWORD_ISSUES, type PasswordHealthReport, type PasswordIssue, type PasswordView } from '@atlas/shared';
import type { Scope } from './scope.js';
import type { SettingsService } from './settings.js';
import type { VaultService } from './vault.js';

const HIBP = 'https://api.pwnedpasswords.com/range/';
const BATCH = 300;
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Breach checks and the password health report.
 *
 * Breach checks use Have I Been Pwned's k-anonymity range API: only the first five characters of the password's
 * SHA-1 hash leave this server, the rest of the comparison happens here. Only how many times a password appears
 * is stored, never the password or its hash.
 */
export class PasswordHealthService {
  constructor(
    private readonly db: Database,
    private readonly vault: VaultService,
    private readonly settings: SettingsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Checks logins never checked (or not for 30 days). Returns how many were checked and whether it stopped early. */
  async checkBreaches(orgId: string, limit = BATCH): Promise<{ checked: number; failed: boolean }> {
    const todo = await this.vault.secretsToCheck(this.db, orgId, limit);
    // Passwords sharing a hash prefix share one request.
    const byPrefix = new Map<string, { id: string; suffix: string }[]>();
    for (const { id, secret } of todo) {
      const hash = createHash('sha1').update(secret).digest('hex').toUpperCase();
      const list = byPrefix.get(hash.slice(0, 5)) ?? [];
      list.push({ id, suffix: hash.slice(5) });
      byPrefix.set(hash.slice(0, 5), list);
    }
    let checked = 0;
    for (const [prefix, items] of byPrefix) {
      let body: string;
      try {
        const res = await this.fetcher(`${HIBP}${prefix}`, {
          headers: { 'Add-Padding': 'true', 'User-Agent': 'MSP-Atlas-password-health' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { checked, failed: true };
        body = await res.text();
      } catch {
        // No internet, or the service is down: leave the rest unchecked and try again next time.
        return { checked, failed: true };
      }
      const seen = new Map<string, number>();
      for (const line of body.split(/\r?\n/)) {
        const [suffix, n] = line.trim().split(':');
        if (suffix && n) seen.set(suffix.toUpperCase(), Number(n) || 0);
      }
      for (const { id, suffix } of items) {
        await this.vault.recordBreach(this.db, orgId, id, seen.get(suffix) ?? 0);
        checked++;
      }
    }
    return { checked, failed: false };
  }

  async enabled(orgId: string) {
    return (await this.settings.passwordHealth(orgId)).breachChecks;
  }

  /** Called by the background loop: about once a day per organization, and only when checks are on. */
  async nightly(orgId: string, now = Date.now()) {
    const s = await this.settings.passwordHealth(orgId);
    if (!s.breachChecks) return;
    if (s.lastRunAt && now - Date.parse(s.lastRunAt) < 20 * 3_600_000) return;
    // Everything due, a batch at a time.
    for (let round = 0; round < 10; round++) {
      const { checked, failed } = await this.checkBreaches(orgId);
      if (failed || checked < BATCH) break;
    }
    await this.settings.saveHealthRun(orgId, new Date(now).toISOString());
  }

  /** The report for what this person may see: vault access and restrictions apply, as in the password list. */
  async report(scope: Scope): Promise<PasswordHealthReport> {
    const list = (await this.vault.list(scope, {})).filter((p) => !p.archived);
    const settings = await this.settings.passwordHealth(scope.actor.orgId);
    const issuesOf = (p: PasswordView): PasswordIssue[] => {
      const found: PasswordIssue[] = [];
      if ((p.breachCount ?? 0) > 0) found.push('breached');
      if (p.kind === 'login' && p.strength < 2) found.push('weak');
      if (p.reused > 0) found.push('reused');
      if (p.rotationDue && p.rotationDue <= today()) found.push('overdue');
      if (p.expiresOn && p.expiresOn <= today()) found.push('expired');
      // With a rotation policy, "overdue" already covers age.
      if (!p.rotationDays && Date.now() - Date.parse(p.changedAt) > 365 * DAY) found.push('old');
      return found;
    };
    const counts = Object.fromEntries(PASSWORD_ISSUES.map((i) => [i, 0])) as Record<PasswordIssue, number>;
    const clients = new Map<string, { id: string; name: string; total: number; withIssues: number }>();
    const items: PasswordHealthReport['items'] = [];
    for (const p of list) {
      const c = clients.get(p.clientId) ?? { id: p.clientId, name: p.clientName, total: 0, withIssues: 0 };
      c.total++;
      const issues = issuesOf(p);
      if (issues.length) {
        c.withIssues++;
        for (const i of issues) counts[i]++;
        items.push({
          id: p.id,
          name: p.name,
          clientId: p.clientId,
          clientName: p.clientName,
          category: p.category,
          issues,
        });
      }
      clients.set(p.clientId, c);
    }
    const pct = (total: number, bad: number) => (total ? Math.round(((total - bad) / total) * 100) : null);
    const unchecked = list.filter((p) => p.kind === 'login' && p.breachCount === null).length;
    const withIssues = items.length;
    return {
      score: pct(list.length, withIssues),
      total: list.length,
      counts,
      clients: [...clients.values()]
        .map((c) => ({ ...c, score: pct(c.total, c.withIssues) }))
        .sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.name.localeCompare(b.name)),
      // Worst first: most issues, breached before anything else.
      items: items.sort(
        (a, b) =>
          Number(b.issues.includes('breached')) - Number(a.issues.includes('breached')) ||
          b.issues.length - a.issues.length ||
          a.clientName.localeCompare(b.clientName) ||
          a.name.localeCompare(b.name),
      ),
      breach: {
        enabled: settings.breachChecks,
        checked: list.filter((p) => p.kind === 'login' && p.breachCount !== null).length,
        unchecked,
        lastRunAt: settings.lastRunAt ?? null,
      },
    };
  }
}
