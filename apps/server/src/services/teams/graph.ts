import { and, eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { ROLE_INFO, type TeamsPost, type TeamsPostPage, teamsPostSchema } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { type Scope, isUuid } from '../scope.js';
import { securityEvent } from '../security-log.js';
import type { TeamsSettingsStore } from './settings.js';
import { TeamsClient, TeamsRequestError } from './client.js';

const segment = (value: string) => encodeURIComponent(value);
export interface GraphMessage {
  id: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: { id?: string; displayName?: string } };
  createdDateTime?: string;
  lastEditedDateTime?: string | null;
}
/** Read messages as text, never inject Teams HTML into Atlas. */
export function teamsText(message: GraphMessage): string {
  const content = (message.body?.content ?? '').slice(0, 30000);
  return message.body?.contentType === 'html'
    ? content
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
    : content;
}
export class TeamsGraph {
  private readonly client: TeamsClient;
  constructor(
    private readonly settings: TeamsSettingsStore,
    fetcher: typeof fetch = fetch,
  ) {
    this.client = new TeamsClient(settings, fetcher);
  }

  async mapping(scope: Scope, clientId: string, write = false) {
    if (!ROLE_INFO[scope.actor.role].staff || !isUuid(clientId)) throw new HttpError(404, 'Teams channel not found.');
    await scope.require(clientId, write ? 'edit' : 'read', 'Teams channel');
    const saved = await this.settings.load(scope.actor.orgId);
    const mapping = saved?.enabled && saved.mappings.find((m) => m.clientId === clientId.toLowerCase());
    if (!mapping) throw new HttpError(404, 'No Teams channel is mapped to this client.');
    return mapping;
  }
  private base(mapping: { teamId: string; channelId: string }) {
    return `/teams/${segment(mapping.teamId)}/channels/${segment(mapping.channelId)}/messages`;
  }
  async notify(
    scope: Scope,
    clientId: string,
    destination: { teamId: string; channelId: string },
    content: string,
    parentMessageId?: string,
  ) {
    const mapping = await this.mapping(scope, clientId, true);
    if (
      mapping.teamId !== destination.teamId ||
      ![mapping.channelId, mapping.securityChannelId].includes(destination.channelId)
    )
      throw new HttpError(409, 'The Teams destination changed. Check the saved client mapping.');
    const path = this.base(destination) + (parentMessageId ? `/${segment(parentMessageId)}/replies` : '');
    const message = (await this.client.request(scope.actor.orgId, path, 'POST', {
      body: { contentType: 'text', content },
    })) as GraphMessage | null;
    if (!message || typeof message.id !== 'string' || !message.id)
      throw new TeamsRequestError('uncertain', 'Teams did not return a message ID. Check the channel before retrying.');
    return { graphMessageId: message.id };
  }
  async list(scope: Scope, clientId: string, parentId?: string, cursor?: string): Promise<TeamsPostPage> {
    const mapping = await this.mapping(scope, clientId);
    const base = this.base(mapping) + (parentId ? `/${segment(parentId)}/replies` : '');
    let path = base + '?$top=50';
    if (cursor) {
      let url: URL;
      try {
        url = new URL(Buffer.from(cursor, 'base64url').toString());
      } catch {
        throw new HttpError(400, 'Invalid Teams page.');
      }
      if (
        url.origin !== 'https://graph.microsoft.com' ||
        decodeURIComponent(url.pathname) !== decodeURIComponent('/v1.0' + base) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new HttpError(400, 'Invalid Teams page.');
      path = url.pathname.slice('/v1.0'.length) + url.search;
    }
    const result = (await this.client.request(scope.actor.orgId, path)) as {
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
    };
    const owned = await scope.db
      .select()
      .from(schema.teamsPosts)
      .where(
        and(
          eq(schema.teamsPosts.orgId, scope.actor.orgId),
          eq(schema.teamsPosts.clientId, clientId),
          eq(schema.teamsPosts.teamId, mapping.teamId),
          eq(schema.teamsPosts.channelId, mapping.channelId),
        ),
      );
    const canWrite = (await scope.level(clientId)) !== 'read';
    const posts: TeamsPost[] = (result.value ?? []).map((m) => ({
      id: m.id,
      author: m.from?.user?.displayName ?? 'Teams app',
      content: teamsText(m),
      createdAt: m.createdDateTime ?? '',
      editedAt: m.lastEditedDateTime ?? null,
      canEdit:
        canWrite &&
        owned.some((p) => p.messageId === m.id && p.parentId === (parentId ?? '') && p.authorId === scope.actor.id),
    }));
    return {
      posts,
      ...(result['@odata.nextLink'] ? { cursor: Buffer.from(result['@odata.nextLink']).toString('base64url') } : {}),
    };
  }
  async create(scope: Scope, clientId: string, input: unknown, ip: string, parentId?: string) {
    const mapping = await this.mapping(scope, clientId, true);
    const { content } = teamsPostSchema.parse(input);
    const path = this.base(mapping) + (parentId ? `/${segment(parentId)}/replies` : '');
    const message = (await this.client.request(scope.actor.orgId, path, 'POST', {
      body: { contentType: 'text', content },
    })) as GraphMessage;
    await scope.db.insert(schema.teamsPosts).values({
      orgId: scope.actor.orgId,
      clientId,
      authorId: scope.actor.id,
      teamId: mapping.teamId,
      channelId: mapping.channelId,
      messageId: message.id,
      parentId: parentId ?? '',
    });
    await securityEvent(scope.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: parentId ? 'Replied in Teams' : 'Created a Teams post',
      detail: `Client ${clientId}; message ${message.id}`,
      ip,
    });
    return { id: message.id };
  }
  async edit(scope: Scope, clientId: string, id: string, input: unknown, ip: string, parentId?: string) {
    const mapping = await this.mapping(scope, clientId, true);
    const { content } = teamsPostSchema.parse(input);
    const [owned] = await scope.db
      .select()
      .from(schema.teamsPosts)
      .where(
        and(
          eq(schema.teamsPosts.orgId, scope.actor.orgId),
          eq(schema.teamsPosts.clientId, clientId),
          eq(schema.teamsPosts.authorId, scope.actor.id),
          eq(schema.teamsPosts.teamId, mapping.teamId),
          eq(schema.teamsPosts.channelId, mapping.channelId),
          eq(schema.teamsPosts.messageId, id),
          eq(schema.teamsPosts.parentId, parentId ?? ''),
        ),
      );
    if (!owned) throw new HttpError(404, 'Only your own Atlas-created Teams posts can be edited here.');
    const path = this.base(mapping) + (parentId ? `/${segment(parentId)}/replies` : '') + `/${segment(id)}`;
    await this.client.request(scope.actor.orgId, path, 'PATCH', { body: { contentType: 'text', content } });
    await securityEvent(scope.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Edited a Teams post',
      detail: `Client ${clientId}; message ${id}`,
      ip,
    });
    return { ok: true };
  }
}
