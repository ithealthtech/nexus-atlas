import { patchOf } from './patch.js';
import { z } from 'zod';
import { ACCESS_LEVELS, ROLES } from './access.js';

export const emailSchema = z.string().trim().toLowerCase().max(254).email('Enter a valid email address.');
export const nameSchema = z.string().trim().min(1, 'Name is required.').max(120);
// Length and variety are checked here; the server adds the email-name rule.
export const passwordSchema = z
  .string()
  .min(12, 'Use a password of at least 12 characters.')
  .max(256, 'Passwords must be 256 characters or fewer.')
  .refine((value) => new Set(value).size >= 5, 'Choose a less repetitive password.');
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code.');

export const signInSchema = z.object({ email: z.string().trim().max(254), password: z.string().max(256) });
export const setupSchema = z.object({
  setupCode: z.string().max(100),
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  organization: z.string().trim().min(1).max(120),
});
export const mfaSchema = z.object({ code: totpCodeSchema });
export const changePasswordSchema = z.object({ current: z.string().max(256), next: passwordSchema });

export const clientGrantSchema = z.object({ clientId: z.string().uuid(), level: z.enum(ACCESS_LEVELS) });
export const userAccessSchema = z.object({
  role: z.enum(ROLES),
  allClients: z.enum(ACCESS_LEVELS).default('none'),
  grants: z.array(clientGrantSchema).max(5000).default([]),
});
export const createUserSchema = userAccessSchema.extend({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export const updateUserSchema = z.object({
  name: nameSchema.optional(),
  role: z.enum(ROLES).optional(),
  allClients: z.enum(ACCESS_LEVELS).optional(),
  grants: z.array(clientGrantSchema).max(5000).optional(),
  disabled: z.boolean().optional(),
});
export const resetUserSchema = z.object({ password: passwordSchema, resetMfa: z.boolean().default(false) });

export const clientStatusSchema = z.enum(['active', 'prospect', 'inactive']);
export const createClientSchema = z.object({
  name: z.string().trim().min(1, 'Client name is required.').max(200),
  type: z.string().trim().max(80).default('Customer'),
  status: clientStatusSchema.default('active'),
  notes: z.string().max(5000).default(''),
  requireRevealReason: z.boolean().default(false),
});
export const updateClientSchema = patchOf(createClientSchema);
