import { z } from 'zod';

const boolean = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url('DATABASE_URL must be a postgres:// connection string.'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4318),
  // The address people use to reach Atlas. Origin and Host checks, cookie security, and links derive from it.
  PUBLIC_URL: z.string().url().default('http://127.0.0.1:4318'),
  TRUST_PROXY: boolean,
  // Master key: 32 bytes, base64url. Provide one of these; in development a key file is created on first run.
  ATLAS_MASTER_KEY: z.string().optional(),
  ATLAS_MASTER_KEY_FILE: z.string().optional(),
  ATLAS_DATA_DIR: z.string().default('./data'),
  ATLAS_SETUP_CODE: z.string().min(12).optional(),
  ATLAS_REQUIRE_STAFF_MFA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ATLAS_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1024).default(25),
  // Local hour (0–23) after which expiry alerts and the Monday digest are emailed.
  ATLAS_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(7),
  // Encrypted backups: made daily after this local hour, kept in this folder (default <data dir>/backups).
  ATLAS_BACKUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ATLAS_BACKUP_DIR: z.string().optional(),
  ATLAS_BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(2),
  ATLAS_BACKUP_KEEP: z.coerce.number().int().min(1).max(365).default(14),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_DIST: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { secureCookies: boolean; publicOrigin: string; publicHost: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Atlas configuration is invalid:\n${problems}`);
  }
  const config = parsed.data;
  const url = new URL(config.PUBLIC_URL);
  const secureCookies = url.protocol === 'https:';
  if (config.NODE_ENV === 'production') {
    if (!secureCookies) throw new Error('PUBLIC_URL must use https:// in production.');
    if (!config.ATLAS_MASTER_KEY && !config.ATLAS_MASTER_KEY_FILE)
      throw new Error(
        'Set ATLAS_MASTER_KEY or ATLAS_MASTER_KEY_FILE in production. Back the key up separately from the database.',
      );
  }
  return { ...config, secureCookies, publicOrigin: url.origin, publicHost: url.host };
}
