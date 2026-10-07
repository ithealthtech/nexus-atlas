import { z } from 'zod';

// ---------- BitLocker collector ----------
// A script the RMM runs as SYSTEM on each Windows machine. It reads BitLocker status and recovery passwords,
// encrypts each password to its enrollment's public key, and uploads the report with the enrollment's token.

export const BITLOCKER_ENROLLMENT_SCOPES = ['client', 'device'] as const;
export type BitlockerEnrollmentScope = (typeof BITLOCKER_ENROLLMENT_SCOPES)[number];

export const createBitlockerEnrollmentSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name the enrollment, for example "All workstations".').max(120),
  // 'client': one script for all of the client's machines. 'device': bound to the first machine that reports.
  scope: z.enum(BITLOCKER_ENROLLMENT_SCOPES).default('client'),
});

const text = z.string().trim().min(1).max(200);
/** A report from the collector. Strict: anything the script doesn't send is refused. */
export const bitlockerReportSchema = z
  .object({
    version: z.literal(1),
    reportId: z.string().uuid(),
    agentId: z.string().uuid(),
    collectedAt: z.string().datetime(),
    machineId: z.string().uuid(),
    hostname: text,
    os: z.string().max(200),
    serialNumber: z.string().max(100),
    volumes: z
      .array(
        z
          .object({
            volumeId: text,
            mountPoint: z.string().max(50),
            protection: z.enum(['On', 'Off', 'Unknown']),
            encryptionMethod: z.string().max(80),
            encryptionPercentage: z.number().int().min(0).max(100),
            conversionStatus: z.string().max(80),
            error: z.string().max(120).optional(),
            protectors: z
              .array(
                z
                  .object({
                    keyId: z.string().uuid(),
                    // RSA-OAEP-SHA256 under a 3072-bit key: 384 bytes, 512 base64 characters.
                    cipher: z.string().regex(/^[A-Za-z0-9+/]{512}$/),
                  })
                  .strict(),
              )
              .max(16),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.volumes.map((v) => v.volumeId)).size !== r.volumes.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate volume' });
    for (const v of r.volumes)
      if (new Set(v.protectors.map((k) => k.keyId)).size !== v.protectors.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate protector' });
    if (r.volumes.reduce((n, v) => n + v.protectors.length, 0) > 64)
      ctx.addIssue({ code: 'custom', message: 'Too many keys' });
    if (Date.parse(r.collectedAt) > Date.now() + 300_000) ctx.addIssue({ code: 'custom', message: 'Future report' });
  });
export type BitlockerReport = z.infer<typeof bitlockerReportSchema>;

export interface BitlockerEnrollmentView {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  scope: BitlockerEnrollmentScope;
  revoked: boolean;
  devices: number;
  lastSeenAt: string | null;
  createdAt: string;
}

/** One volume's encryption status, as last reported. */
export interface BitlockerVolumeView {
  mountPoint: string;
  protection: 'On' | 'Off' | 'Unknown';
  encryptionMethod: string;
  encryptionPercentage: number;
  conversionStatus: string;
  /** How many recovery passwords the volume has. Zero means none could be saved. */
  keys: number;
  error: string | null;
}

export interface BitlockerDeviceView {
  id: string;
  enrollmentId: string;
  clientId: string;
  clientName: string;
  hostname: string;
  os: string;
  serialNumber: string;
  assetId: string | null;
  assetName: string | null;
  volumes: BitlockerVolumeView[];
  /** 'protected': every fixed volume is on. 'unprotected': at least one is off. 'unknown': couldn't be read. */
  status: 'protected' | 'unprotected' | 'unknown';
  collectedAt: string;
  lastSeenAt: string;
  blocked: boolean;
}

/** Returned once, when an enrollment is made: the script with its token inside. The token can't be shown again. */
export interface BitlockerEnrollmentCreated {
  enrollment: BitlockerEnrollmentView;
  filename: string;
  script: string;
}
