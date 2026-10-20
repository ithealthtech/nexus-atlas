import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { reportSelectionSchema } from '@atlas/shared';
import { z } from 'zod';
import { ReportService } from '../services/reports.js';
import { Scope } from '../services/scope.js';
import { reportCsv, reportPdf } from '../services/report-export.js';
import { HttpError } from '../errors.js';
import type { SettingsService } from '../services/settings.js';
import type { SecuritySources } from '../services/report-data.js';
import { ReportShareService } from '../services/report-shares.js';

export function registerReportRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    settings: SettingsService;
    fetcher?: typeof fetch;
    security?: SecuritySources;
    /** Atlas's own address, for report links. */
    publicOrigin: string;
    /** Wrong report-link attempts per address. */
    shareLimiter: { check(key: string): void; fail(key: string): void };
  },
) {
  const { db, authed } = deps;
  const service = new ReportService(deps.settings, deps.fetcher, deps.security);
  const scopeOf = (req: FastifyRequest) => new Scope(db, req.session!.actor);
  const shares = new ReportShareService(db, deps.publicOrigin);
  const audit = async (req: FastifyRequest, action: string, id: string) => {
    const actor = req.session!.actor;
    await db
      .insert(schema.securityEvents)
      .values({ orgId: actor.orgId, userId: actor.id, actor: actor.name, action, detail: `Report ${id}`, ip: req.ip });
  };
  const base = '/api/reports';
  app.get(base + '/runs', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return service.history(scopeOf(req));
  });
  app.post(base + '/runs', authed, async (req, reply) => {
    const run = await service.generate(scopeOf(req), req.body);
    await audit(req, 'Generated report', run.id);
    return reply.status(201).send(run);
  });
  app.get<{ Params: { id: string } }>(base + '/runs/:id', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return service.load(scopeOf(req), req.params.id);
  });
  app.delete<{ Params: { id: string } }>(base + '/runs/:id', authed, async (req) => {
    await service.remove(scopeOf(req), req.params.id);
    await audit(req, 'Deleted report', req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { format?: string; selection?: string } }>(
    base + '/runs/:id/export',
    authed,
    async (req, reply) => {
      const format = z.enum(['csv', 'pdf']).parse(req.query.format);
      let raw: unknown = {};
      try {
        if (req.query.selection) {
          if (req.query.selection.length > 4000) throw new Error();
          raw = JSON.parse(req.query.selection);
        }
      } catch {
        throw new HttpError(400, 'Invalid report selection.');
      }
      const selection = reportSelectionSchema.parse(raw);
      const run = await service.load(scopeOf(req), req.params.id);
      let content: Buffer | string;
      try {
        if (format === 'pdf') {
          // Exports carry the organization's own name, logo and accent colour (Administration → Theme).
          const brand = await deps.settings.branding(req.session!.actor.orgId);
          content = await reportPdf(run.snapshot, selection, {
            name: brand.brandName,
            logo: brand.logo,
            accent: brand.accent,
          });
        } else content = reportCsv(run.snapshot, selection);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, 'The report could not be exported. Check the selected section and columns.');
      }
      await audit(req, `Exported report as ${format.toUpperCase()}`, run.id);
      return reply
        .header('cache-control', 'no-store')
        .header('content-disposition', `attachment; filename="atlas-report-${run.id}.${format}"`)
        .type(format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8')
        .send(content);
    },
  );
  // ---- links to share a single-client snapshot with someone without an account ----
  app.get<{ Params: { id: string } }>(base + '/runs/:id/shares', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return shares.list(scopeOf(req), req.params.id);
  });
  app.post<{ Params: { id: string } }>(base + '/runs/:id/shares', authed, async (req, reply) =>
    reply.status(201).send(await shares.create(scopeOf(req), req.params.id, req.body, req.ip)),
  );
  app.delete<{ Params: { id: string } }>('/api/report-shares/:id', authed, async (req) =>
    shares.revoke(scopeOf(req), req.params.id, req.ip),
  );
  // Opening a link needs no account. Wrong links count toward the per-address limit, so they can't be guessed.
  const publicHeaders = {
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  };
  const opened = async (req: FastifyRequest, token: string) => {
    deps.shareLimiter.check(req.ip);
    try {
      return await shares.open(token);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) deps.shareLimiter.fail(req.ip);
      throw error;
    }
  };
  app.get<{ Params: { token: string } }>('/api/shared-reports/:token', async (req, reply) =>
    reply.headers(publicHeaders).send(shares.shared(await opened(req, req.params.token))),
  );
  app.get<{ Params: { token: string }; Querystring: { section?: string } }>(
    '/api/shared-reports/:token/pdf',
    async (req, reply) => {
      const share = await opened(req, req.params.token);
      const section = Number(req.query.section ?? 0);
      if (!Number.isInteger(section) || section < 0 || section >= share.snapshot.sections.length)
        throw new HttpError(400, 'Choose a report section.');
      const brand = await deps.settings.branding(share.orgId);
      let content: Buffer;
      try {
        // Shared outside Atlas, the PDF names the organization rather than the person who ran it.
        const snapshot = { ...share.snapshot, generatedBy: brand.brandName || share.organization };
        content = await reportPdf(snapshot, reportSelectionSchema.parse({ section }), {
          name: brand.brandName,
          logo: brand.logo,
          accent: brand.accent,
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, 'The report could not be exported.');
      }
      return reply
        .headers(publicHeaders)
        .header('content-disposition', 'attachment; filename="report.pdf"')
        .type('application/pdf')
        .send(content);
    },
  );
  app.get(base + '/templates', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return service.listTemplates(scopeOf(req));
  });
  app.post(base + '/templates', authed, async (req, reply) => {
    const result = await service.saveTemplate(scopeOf(req), req.body);
    await audit(req, 'Saved report template', result.id);
    return reply.status(201).send(result);
  });
  app.put<{ Params: { id: string } }>(base + '/templates/:id', authed, async (req) => {
    const result = await service.saveTemplate(scopeOf(req), req.body, req.params.id);
    await audit(req, 'Updated report template', result.id);
    return result;
  });
  app.delete<{ Params: { id: string } }>(base + '/templates/:id', authed, async (req) => {
    const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
    await service.removeTemplate(scopeOf(req), req.params.id, version);
    await audit(req, 'Deleted report template', req.params.id);
    return { ok: true };
  });
}
