import type { FastifyRequest } from 'fastify';
import { schema, type Database } from '@atlas/db';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type SecurityEvent = typeof schema.securityEvents.$inferInsert;

/**
 * Writes one security-log entry. Every entry goes through here, so they are all shaped the same way: the detail
 * and address are trimmed to a sensible length, and the database trigger adds each row to the tamper-evident hash
 * chain. Pass the transaction when the entry belongs with a change, so both are kept or neither is.
 */
export function securityEvent(db: Database | Tx, event: SecurityEvent) {
  return db.insert(schema.securityEvents).values({
    ...event,
    detail: (event.detail ?? '').slice(0, 300),
    ip: (event.ip ?? '').slice(0, 64),
  });
}

/** A security-log entry for something the signed-in user just did, from this request's address. */
export function requestEvent(db: Database | Tx, req: FastifyRequest, action: string, detail = '') {
  const { actor } = req.session!;
  return securityEvent(db, { orgId: actor.orgId, userId: actor.id, actor: actor.name, action, detail, ip: req.ip });
}
