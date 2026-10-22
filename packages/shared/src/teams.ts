import { z } from 'zod';

const guid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const channelId = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^19:[A-Za-z0-9._:@-]+$/, 'Enter a Teams channel ID.');
export const TEAMS_ALERT_KINDS = ['expiration', 'review', 'breach', 'infection'] as const;
export type TeamsAlertKind = (typeof TEAMS_ALERT_KINDS)[number];
export const TEAMS_ALERT_LABELS: Record<TeamsAlertKind, string> = {
  expiration: 'Expirations',
  review: 'Document reviews',
  breach: 'Password breaches',
  infection: 'Confirmed infections',
};
export const teamsMappingSchema = z.object({
  clientId: guid,
  teamId: guid,
  channelId,
  channelName: z.string().trim().min(1).max(100),
  securityChannelId: channelId.optional(),
});
export type TeamsMapping = z.infer<typeof teamsMappingSchema>;
export const teamsSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    tenantId: guid.optional(),
    appId: guid.optional(),
    clientSecret: z.string().max(4000).optional(),
    alerts: z
      .array(z.enum(TEAMS_ALERT_KINDS))
      .max(4)
      .default([...TEAMS_ALERT_KINDS]),
    reminderDays: z.array(z.number().int().min(0).max(365)).min(1).max(12).default([30, 14, 7, 1, 0]),
    digestHour: z.number().int().min(0).max(23).default(8),
    timeZone: z
      .string()
      .max(100)
      .default('UTC')
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Choose a valid time zone.'),
    mappings: z.array(teamsMappingSchema).max(500).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.enabled && (!v.tenantId || !v.appId))
      ctx.addIssue({ code: 'custom', message: 'Enter the tenant and application IDs.' });
    if (new Set(v.mappings.map((m) => m.clientId)).size !== v.mappings.length)
      ctx.addIssue({ code: 'custom', message: 'Map each client once.' });
    if (new Set(v.mappings.map((m) => `${m.teamId}:${m.channelId}`)).size !== v.mappings.length)
      ctx.addIssue({ code: 'custom', message: 'Give each client its own discussion channel.' });
    if (
      v.mappings.some((m) =>
        v.mappings.some(
          (other) =>
            other.clientId !== m.clientId && other.teamId === m.teamId && other.securityChannelId === m.channelId,
        ),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'A shared security destination cannot be another client’s discussion channel.',
      });
  });
export type TeamsSettings = Omit<z.infer<typeof teamsSettingsSchema>, 'clientSecret'>;
export interface TeamsSettingsView extends TeamsSettings {
  hasClientSecret: boolean;
  connection: { name: string; connectedAt: string } | null;
}
export const teamsPostSchema = z.object({ content: z.string().trim().min(1).max(12000) });
export const teamsPageSchema = z.object({ cursor: z.string().max(8000).optional() });
export const teamsInfectionSchema = z.object({
  eventId: z.string().trim().min(1).max(150),
  assetId: guid,
  status: z.enum(['active', 'resolved']),
  source: z.string().trim().min(1).max(100),
});
export interface TeamsPost {
  id: string;
  author: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
}
export interface TeamsPostPage {
  posts: TeamsPost[];
  cursor?: string;
}
export interface TeamsDelivery {
  id: string;
  kind: TeamsAlertKind;
  clientId: string;
  status: string;
  attempts: number;
  error: string;
  createdAt: string;
}
