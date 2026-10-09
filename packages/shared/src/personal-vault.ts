import { z } from 'zod';
import { MAX_NOTE_LENGTH, MAX_SECRET_LENGTH, totpSecret, webAddress } from './vault.js';

// ---------- personal vaults ----------
// Each staff member's own logins and notes. Only that person can list, read, change, or delete them: there is no
// sharing, no administrator view, and no entry in the vault audit log.
export const PERSONAL_KINDS = ['login', 'note'] as const;
export type PersonalKind = (typeof PERSONAL_KINDS)[number];
/** How many entries one person may keep. */
export const MAX_PERSONAL_ENTRIES = 2000;

const fields = {
  name: z.string().trim().min(1, 'Name is required.').max(200),
  username: z.string().trim().max(254),
  url: webAddress,
  notes: z.string().max(MAX_NOTE_LENGTH),
  totp: totpSecret,
};
const withinLimit = (p: { kind?: PersonalKind; secret?: string }) =>
  p.kind === 'note' || p.secret === undefined || p.secret.length <= MAX_SECRET_LENGTH;
const tooLong = { message: `A password can be up to ${MAX_SECRET_LENGTH} characters.`, path: ['secret'] };

export const createPersonalPasswordSchema = z
  .object({
    kind: z.enum(PERSONAL_KINDS).default('login'),
    name: fields.name,
    username: fields.username.default(''),
    url: fields.url.default(''),
    // A login's password, or a note's text.
    secret: z.string().max(MAX_NOTE_LENGTH),
    notes: fields.notes.default(''),
    totp: fields.totp.default(''),
    favorite: z.boolean().default(false),
  })
  .superRefine((p, ctx) => {
    if (!p.secret.length)
      ctx.addIssue({
        code: 'custom',
        message: p.kind === 'note' ? 'Write the note.' : 'The password is required.',
        path: ['secret'],
      });
  })
  .refine(withinLimit, tooLong);

/** Anything left out stays as it is. The kind never changes. */
export const updatePersonalPasswordSchema = z.object({
  name: fields.name.optional(),
  username: fields.username.optional(),
  url: fields.url.optional(),
  secret: z.string().min(1, 'The password is required.').max(MAX_NOTE_LENGTH).optional(),
  notes: fields.notes.optional(),
  totp: fields.totp.optional(),
  favorite: z.boolean().optional(),
  version: z.number().int().positive(),
});

export const personalRevealSchema = z.object({ field: z.enum(['secret', 'notes', 'totp']).default('secret') });

export interface PersonalPasswordView {
  id: string;
  kind: PersonalKind;
  name: string;
  username: string;
  url: string;
  hasNotes: boolean;
  hasTotp: boolean;
  /** 0–4 for a login; a note has none. */
  strength: number | null;
  favorite: boolean;
  /** When the password or note text last changed. */
  changedAt: string;
  updatedAt: string;
  version: number;
}

/** Whether the signed-in person has a personal vault, for the navigation. */
export interface PersonalVaultStatus {
  enabled: boolean;
  count: number;
}
