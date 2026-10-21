import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  nextReportRun,
  reportDefinitionSchema,
  reportNeedsAttention,
  reportScheduleSchema,
  type ReportDeliveryView,
  type ReportRunDetail,
  type ReportScheduleView,
} from '@atlas/shared';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { requireClient } from '../authz.js';
import { actorFor } from '../identity/service.js';
import type { MailAttachment, MailService } from './mail.js';
import { reportPdf } from './report-export.js';
import type { ReportShareService } from './report-shares.js';
import type { ReportService } from './reports.js';
import { isUuid, Scope } from './scope.js';
import { securityEvent } from './security-log.js';
import type { SettingsService } from './settings.js';

type Row = typeof schema.reportSchedules.$inferSelect;
/** How many due schedules one background pass sends, so a backlog is spread over several passes. */
const PER_PASS = 25;
/** Microsoft 365 refuses messages much over 3 MB; a bigger PDF is left off with a note instead. */
const MAX_ATTACHMENT = 3 * 1024 * 1024;

const view = (row: Row): ReportScheduleView => ({
  id: row.id,
  name: row.name,
  definition: reportDefinitionSchema.parse(row.definition),
  cadence: row.cadence as ReportScheduleView['cadence'],
  day: row.day,
  hour: row.hour,
  recipients: row.recipients,
  attachPdf: row.attachPdf,
  clientLink: row.clientLink,
  enabled: row.enabled,
  version: row.version,
  nextRunAt: row.nextRunAt.toISOString(),
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastStatus: (row.lastStatus as ReportScheduleView['lastStatus']) ?? null,
  lastError: row.lastError,
  lastRunId: row.lastRunId,
});

/**
 * Reports run on a schedule and emailed. Each schedule belongs to the person who made it and runs as them, with
 * their access at the time it runs: the snapshot lands in their report history (so Compare works on it), and a
 * schedule never shows anyone more than its owner could see. The background notifier calls `runDue` on every pass;
 * its database lock keeps two servers from sending the same report.
 */
export class ReportScheduleService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      reports: ReportService;
      shares: ReportShareService;
      mail: MailService;
      settings: SettingsService;
    },
  ) {}

  private async own(scope: Scope, id: string) {
    const [row] = isUuid(id)
      ? await scope.db
          .select()
          .from(schema.reportSchedules)
          .where(
            and(
              eq(schema.reportSchedules.id, id.toLowerCase()),
              eq(schema.reportSchedules.orgId, scope.actor.orgId),
              eq(schema.reportSchedules.ownerId, scope.actor.id),
            ),
          )
      : [];
    if (!row) throw new HttpError(404, 'Scheduled report not found.');
    return row;
  }

  /** The clients must be ones this person can read, and a client link needs edit access, as sharing does. */
  private async check(scope: Scope, input: z.infer<typeof reportScheduleSchema>) {
    for (const id of input.definition.clientIds) await requireClient(scope.db, scope.actor, id, 'read');
    if (input.clientLink) await scope.require(input.definition.clientIds[0]!, 'edit', 'Client');
  }

  async list(scope: Scope): Promise<ReportScheduleView[]> {
    const rows = await scope.db
      .select()
      .from(schema.reportSchedules)
      .where(
        and(eq(schema.reportSchedules.orgId, scope.actor.orgId), eq(schema.reportSchedules.ownerId, scope.actor.id)),
      )
      .orderBy(asc(schema.reportSchedules.name));
    return rows.map(view);
  }

  async save(scope: Scope, input: unknown, ip: string, id?: string): Promise<ReportScheduleView> {
    const body = reportScheduleSchema.parse(input);
    await this.check(scope, body);
    const values = {
      name: body.name,
      definition: body.definition,
      cadence: body.cadence,
      day: body.day,
      hour: body.hour,
      recipients: body.recipients,
      attachPdf: body.attachPdf,
      clientLink: body.clientLink,
      enabled: body.enabled,
      nextRunAt: nextReportRun(body, new Date()),
    };
    let row: Row | undefined;
    if (id) {
      const { version } = z.object({ version: z.number().int().positive() }).parse(input);
      await this.own(scope, id);
      [row] = await scope.db
        .update(schema.reportSchedules)
        .set({ ...values, version: version + 1, updatedAt: new Date() })
        .where(and(eq(schema.reportSchedules.id, id.toLowerCase()), eq(schema.reportSchedules.version, version)))
        .returning();
      if (!row) throw new HttpError(409, 'This schedule was changed elsewhere. Reload it and try again.');
    } else {
      [row] = await scope.db
        .insert(schema.reportSchedules)
        .values({ ...values, orgId: scope.actor.orgId, ownerId: scope.actor.id })
        .returning();
    }
    await securityEvent(scope.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: id ? 'Changed a scheduled report' : 'Scheduled a report',
      detail: `${body.name}: ${body.cadence}, to ${body.recipients.length} recipient${body.recipients.length === 1 ? '' : 's'}`,
      ip,
    });
    return view(row!);
  }

  async remove(scope: Scope, id: string, version: number, ip: string) {
    const row = await this.own(scope, id);
    const removed = await scope.db
      .delete(schema.reportSchedules)
      .where(and(eq(schema.reportSchedules.id, row.id), eq(schema.reportSchedules.version, version)))
      .returning({ id: schema.reportSchedules.id });
    if (!removed.length) throw new HttpError(409, 'This schedule was changed elsewhere. Reload it and try again.');
    await securityEvent(scope.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Deleted a scheduled report',
      detail: row.name,
      ip,
    });
  }

  /** Sends a schedule now, for a check before its first run. Its regular time doesn't move. */
  async sendNow(scope: Scope, id: string): Promise<ReportScheduleView> {
    const row = await this.own(scope, id);
    return view(await this.deliver(row, new Date(), 'manual'));
  }

  /**
   * Sends every schedule in the organization that has come due. Each is claimed first by moving it to its next
   * time, so a failure is recorded on the schedule rather than retried on every pass, and a second server finds
   * nothing left to send.
   */
  async runDue(orgId: string, now = new Date()) {
    const due = await this.db
      .select()
      .from(schema.reportSchedules)
      .where(
        and(
          eq(schema.reportSchedules.orgId, orgId),
          eq(schema.reportSchedules.enabled, true),
          lte(schema.reportSchedules.nextRunAt, now),
        ),
      )
      .orderBy(asc(schema.reportSchedules.nextRunAt))
      .limit(PER_PASS);
    for (const row of due) {
      const [claimed] = await this.db
        .update(schema.reportSchedules)
        .set({ nextRunAt: nextReportRun(view(row), now) })
        .where(and(eq(schema.reportSchedules.id, row.id), eq(schema.reportSchedules.nextRunAt, row.nextRunAt)))
        .returning();
      if (claimed) await this.deliver(claimed, now, 'schedule');
    }
  }

  /** The schedule's recent deliveries, newest first. */
  async deliveries(scope: Scope, scheduleId: string): Promise<ReportDeliveryView[]> {
    const row = await this.own(scope, scheduleId);
    const rows = await scope.db
      .select()
      .from(schema.reportDeliveries)
      .where(eq(schema.reportDeliveries.scheduleId, row.id))
      .orderBy(desc(schema.reportDeliveries.createdAt))
      .limit(50);
    return rows.map((d) => ({
      id: d.id,
      recipient: d.recipient,
      status: d.status as ReportDeliveryView['status'],
      error: d.error,
      trigger: d.trigger as ReportDeliveryView['trigger'],
      createdAt: d.createdAt.toISOString(),
      canResend: !!d.runId,
    }));
  }

  /** Sends one delivery's snapshot again to its recipient, as it was: the report isn't run again. */
  async resend(scope: Scope, deliveryId: string, ip: string): Promise<ReportDeliveryView[]> {
    const [found] = isUuid(deliveryId)
      ? await scope.db
          .select({ delivery: schema.reportDeliveries, schedule: schema.reportSchedules })
          .from(schema.reportDeliveries)
          .innerJoin(schema.reportSchedules, eq(schema.reportSchedules.id, schema.reportDeliveries.scheduleId))
          .where(
            and(
              eq(schema.reportDeliveries.id, deliveryId.toLowerCase()),
              eq(schema.reportSchedules.orgId, scope.actor.orgId),
              eq(schema.reportSchedules.ownerId, scope.actor.id),
            ),
          )
      : [];
    if (!found) throw new HttpError(404, 'Delivery not found.');
    if (!found.delivery.runId)
      throw new HttpError(409, 'The report sent then is no longer in your history, so it can’t be sent again.');
    // Checks the owner still has access to every client in it.
    const run = await this.deps.reports.load(scope, found.delivery.runId);
    const composed = await this.compose(found.schedule, scope, run);
    await this.sendTo(found.schedule, run.id, composed, [found.delivery.recipient], 'resend');
    await securityEvent(scope.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Resent a scheduled report',
      detail: `${found.schedule.name} to ${found.delivery.recipient}`,
      ip,
    });
    return this.deliveries(scope, found.schedule.id);
  }

  /** Runs the report as its owner and emails it. Never throws: the outcome is recorded on the schedule. */
  private async deliver(row: Row, now: Date, trigger: 'schedule' | 'manual'): Promise<Row> {
    const record = async (status: 'sent' | 'failed', error: string, runId?: string) => {
      const [saved] = await this.db
        .update(schema.reportSchedules)
        .set({ lastRunAt: now, lastStatus: status, lastError: error.slice(0, 500), lastRunId: runId ?? row.lastRunId })
        .where(eq(schema.reportSchedules.id, row.id))
        .returning();
      return saved ?? row;
    };
    const [owner] = await this.db.select().from(schema.users).where(eq(schema.users.id, row.ownerId));
    if (!owner || owner.disabled)
      return record('failed', 'The person who made this schedule can no longer sign in, so it was not sent.');
    const scope = new Scope(this.db, actorFor(owner));
    let run;
    try {
      run = await this.deps.reports.generate(scope, row.definition);
    } catch (error) {
      return record('failed', `The report could not be run: ${(error as Error).message}`);
    }
    const composed = await this.compose(row, scope, run);
    const failed = await this.sendTo(row, run.id, composed, row.recipients, trigger);
    await securityEvent(this.db, {
      orgId: row.orgId,
      userId: owner.id,
      actor: owner.name,
      action: 'Sent a scheduled report',
      detail: `${row.name} to ${row.recipients.length - failed.length} of ${row.recipients.length} recipients`,
    });
    const notes = composed.notes.join(' ');
    if (failed.length)
      return record(
        'failed',
        `Not delivered to ${failed.map((f) => f.to).join(', ')}: ${failed[0]!.reason}${notes ? ` ${notes}` : ''}`,
        run.id,
      );
    return record('sent', notes, run.id);
  }

  /** The email for one run of a schedule: a summary, the PDF, and the client link, as the schedule asks. */
  private async compose(row: Row, scope: Scope, run: ReportRunDetail) {
    const { snapshot } = run;
    const [org] = await this.db
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, row.orgId));
    const brand = await this.deps.settings.branding(row.orgId);
    const organization = brand.brandName || org?.name || snapshot.organization;
    const notes: string[] = [];
    const captured = snapshot.generatedAt.slice(0, 10);
    const attachments: MailAttachment[] = [];
    if (row.attachPdf) {
      try {
        const pdf = await reportPdf(snapshot, 'all', { name: brand.brandName, logo: brand.logo, accent: brand.accent });
        if (pdf.length > MAX_ATTACHMENT) notes.push('The PDF was too large to attach.');
        else
          attachments.push({
            filename: `${row.name.replace(/[^\w -]+/g, '').trim() || 'Report'} ${captured}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
          });
      } catch (error) {
        notes.push(`The PDF could not be attached: ${(error as Error).message}`);
      }
    }
    let link: string | null = null;
    if (row.clientLink && snapshot.clients.length === 1) {
      try {
        link = (await this.deps.shares.create(scope, run.id, { expiresDays: 30 }, 'scheduled report')).url;
      } catch (error) {
        notes.push(`No client link was made: ${(error as Error).message}`);
      }
    }
    const clients = snapshot.clients.map((c) => c.name);
    const who =
      clients.length > 3 ? `${clients.slice(0, 3).join(', ')} and ${clients.length - 3} more` : clients.join(', ');
    const flagged = snapshot.sections.reduce((n, s) => n + s.rows.filter((r) => reportNeedsAttention(s, r)).length, 0);
    const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const message = {
      subject: `${row.name}: ${who}`,
      paragraphs: [
        `Here is ${snapshot.definition.title} for ${who}, captured ${captured}.`,
        flagged
          ? `${count(flagged, 'item')} may need attention; they are listed in the report.`
          : 'Nothing in this report is flagged as needing attention.',
        ...(snapshot.warnings.length
          ? [`${count(snapshot.warnings.length, 'note')} about the data are in the report.`]
          : []),
        ...(attachments.length ? ['The full report is attached as a PDF.'] : []),
      ],
      rows: snapshot.sections.map((s) => ({ cells: [s.title, `${s.rows.length} rows`] })),
      ...(link ? { action: { label: 'View the report', url: link } } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
    return { message, notes, organization };
  }

  /** Emails each recipient on their own, so one refused address doesn't stop the rest, and logs every attempt. */
  private async sendTo(
    row: Row,
    runId: string,
    composed: Awaited<ReturnType<ReportScheduleService['compose']>>,
    recipients: string[],
    trigger: ReportDeliveryView['trigger'],
  ) {
    const failed: { to: string; reason: string }[] = [];
    const log: (typeof schema.reportDeliveries.$inferInsert)[] = [];
    for (const to of recipients) {
      try {
        await this.deps.mail.send(row.orgId, composed.organization, { ...composed.message, to });
        log.push({ orgId: row.orgId, scheduleId: row.id, runId, recipient: to, status: 'sent', trigger });
      } catch (error) {
        const reason = (error as Error).message;
        failed.push({ to, reason });
        log.push({
          orgId: row.orgId,
          scheduleId: row.id,
          runId,
          recipient: to,
          status: 'failed',
          error: reason.slice(0, 500),
          trigger,
        });
      }
    }
    if (log.length) await this.db.insert(schema.reportDeliveries).values(log);
    return failed;
  }
}
