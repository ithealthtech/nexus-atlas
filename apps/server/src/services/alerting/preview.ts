import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ROLE_INFO,
  alertPreviewSchema,
  alertSampleValues,
  matchAlertRule,
  renderAlertTemplate,
  type AlertPreview,
  type AlertRule,
  type AlertSample,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { actorFor } from '../../identity/service.js';
import { Scope } from '../scope.js';
import type { SettingsService } from '../settings.js';
import type { TeamsSettingsStore } from '../teams/settings.js';
import { securityEvent } from '../security-log.js';
import { AlertWorkspaceService, requireAlertAdmin } from './workspace.js';

export class AlertPreviewService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      settings: SettingsService;
      teams: TeamsSettingsStore;
      publicOrigin: string;
    },
  ) {}

  async preview(scope: Scope, input: unknown, ip: string): Promise<AlertPreview> {
    const orgId = requireAlertAdmin(scope);
    const { template, rule, sample } = alertPreviewSchema.parse(input);
    let clientName = 'Example client';
    if (sample.clientId) {
      await scope.require(sample.clientId, 'read', 'Client');
      const [client] = await this.db
        .select({ name: schema.clients.name })
        .from(schema.clients)
        .where(and(eq(schema.clients.orgId, orgId), eq(schema.clients.id, sample.clientId)));
      if (!client) throw new HttpError(404, 'Client not found.');
      clientName = client.name;
    }
    if (rule) await new AlertWorkspaceService(this.db).validateReferences(scope, [rule]);
    const values = alertSampleValues(
      sample,
      clientName,
      new URL(sample.clientId ? `/clients/${sample.clientId}` : '/expirations', this.deps.publicOrigin).href,
    );
    let rendered: ReturnType<typeof renderAlertTemplate>;
    try {
      rendered = renderAlertTemplate(template, values);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    const match = rule ? matchAlertRule(rule, sample) : { matched: true, reasons: ['Template preview only'] };
    const destinations = rule ? await this.destinations(scope, rule, sample) : [];
    await securityEvent(this.db, {
      orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Alert draft previewed',
      detail: `Synthetic ${sample.kind} example; ${rule ? 'rule dry run' : 'template only'}; no delivery`,
      ip,
    });
    return { ...rendered, ...match, destinations };
  }

  private async destinations(
    scope: Scope,
    rule: AlertRule,
    sample: AlertSample,
  ): Promise<AlertPreview['destinations']> {
    const destinations: AlertPreview['destinations'] = [];
    if (rule.emailUserIds.length) {
      const email = await this.deps.settings.smtpView(scope.actor.orgId);
      const configured =
        email.enabled &&
        !!email.fromAddress &&
        (email.method === 'graph' ? !!email.tenantId && !!email.clientId && email.hasClientSecret : !!email.host);
      const users = await this.db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.orgId, scope.actor.orgId), inArray(schema.users.id, rule.emailUserIds)));
      for (const user of users) {
        const actor = actorFor(user);
        const recipient = new Scope(this.db, actor);
        const access =
          sample.clientId !== null &&
          !user.disabled &&
          ROLE_INFO[actor.role].staff &&
          (await recipient.level(sample.clientId)) !== 'none';
        destinations.push({
          label: `Email: ${user.name} (${user.email})`,
          ready: configured && access,
          detail:
            sample.clientId === null
              ? 'Choose a client to check this recipient’s access.'
              : !access
                ? 'Recipient cannot read this client.'
                : configured
                  ? 'Configured; no email sent.'
                  : 'Set up email in Connections.',
        });
      }
    }
    if (rule.teams) {
      const teams = await this.deps.teams.view(scope.actor.orgId);
      const mapping = teams.mappings.find((m) => m.clientId === sample.clientId);
      const security = ['breach', 'infection'].includes(sample.kind) && !!mapping?.securityChannelId;
      const ready = teams.enabled && !!teams.connection && !!mapping;
      destinations.push({
        label: mapping
          ? `Teams: ${mapping.channelName}${security ? ' (security channel)' : ''}`
          : 'Teams: client channel',
        ready,
        detail: !mapping
          ? 'Map a Teams channel for this client.'
          : ready
            ? 'Mapped and connected; no post sent.'
            : 'Enable Teams and connect an account.',
      });
    }
    return destinations;
  }
}
