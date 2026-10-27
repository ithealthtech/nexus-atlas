import { z } from 'zod';
import { alertWorkspaceSchema, type AlertWorkspace } from './alerting.js';

export const alertVersionNumberSchema = z.coerce.number().int().min(1).max(2147483647);
const revision = alertWorkspaceSchema.shape.revision;
export const publishAlertsSchema = z.object({
  revision,
  lastVersion: z.number().int().min(0).max(2147483646),
  note: z.string().trim().min(1).max(300),
});
export const restoreAlertsSchema = z.object({ revision });
export const alertHistoryQuerySchema = z.object({ beforeVersion: alertVersionNumberSchema.optional() });

export interface AlertVersionSummary {
  version: number;
  draftRevision: number;
  note: string;
  publishedBy: string;
  publishedAt: string;
  templateCount: number;
  ruleCount: number;
}
export interface AlertVersion extends AlertVersionSummary {
  workspace: AlertWorkspace;
}
export interface AlertVersionHistory {
  latestVersion: number;
  versions: AlertVersionSummary[];
  nextBeforeVersion: number | null;
}
