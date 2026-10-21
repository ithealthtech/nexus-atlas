import { z } from 'zod';

export const licenseSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    vendor: z.string().trim().max(160).default(''),
    seats: z.number().int().min(1).max(1_000_000),
    assignments: z.array(z.string().trim().min(1).max(254)).max(10_000).default([]),
    unitCostCents: z.number().int().min(0).max(100_000_000).default(0),
    currency: z.enum(['USD', 'CAD', 'EUR', 'GBP', 'AUD']).default('USD'),
    billingCycle: z.enum(['monthly', 'annual', 'one_time']).default('monthly'),
    renewalDate: z.iso.date().nullable().default(null),
    autoRenew: z.boolean().default(false),
    status: z.enum(['active', 'cancelled']).default('active'),
    notes: z.string().trim().max(5000).default(''),
  })
  .superRefine((value, ctx) => {
    if (value.assignments.length > value.seats)
      ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Assignments cannot exceed purchased seats.' });
    if (new Set(value.assignments.map((a) => a.toLowerCase())).size !== value.assignments.length)
      ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Each assignment must be unique.' });
  });

export type LicenseInput = z.infer<typeof licenseSchema>;
export interface LicenseView extends LicenseInput {
  id: string;
  clientId: string;
  version: number;
  updatedAt: string;
}
export const licenseUpdateSchema = z.object({ version: z.number().int().positive(), license: licenseSchema });
export const licenseAssignmentSchema = z.object({
  userId: z.uuid().transform((id) => id.toLowerCase()),
  skuId: z.uuid().transform((id) => id.toLowerCase()),
  action: z.enum(['assign', 'remove']),
});
export interface MicrosoftLicenseView {
  tenantId: string;
  checkedAt: string;
  skus: { id: string; name: string; part: string; enabled: number; assigned: number; status: string }[];
  users: {
    id: string;
    name: string;
    upn: string;
    /** False when sign-in is blocked: often someone who has left, still holding licenses. */
    enabled: boolean;
    skuIds: string[];
    groupSkuIds: string[];
  }[];
}
export interface ClientLicensesView {
  licenses: LicenseView[];
  microsoft: null | { tenantId: string; name: string | null; mode: 'gdap' | 'application' };
}
