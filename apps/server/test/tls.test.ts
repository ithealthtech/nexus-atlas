import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { startApp, type TestApp } from './helpers.js';

// A self-signed certificate for 127.0.0.1, made for these tests only.
const PFX = fileURLToPath(new URL('./fixtures/test-only-tls.pfx', import.meta.url));
const PASSPHRASE = 'atlas-test-only';

describe('HTTPS served by Atlas itself', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('serves HTTPS with the certificate it is given', async () => {
    t = await startApp({
      PUBLIC_URL: 'https://127.0.0.1:4318',
      ATLAS_TLS_PFX_FILE: PFX,
      ATLAS_TLS_PFX_PASSPHRASE: PASSPHRASE,
    });
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as { port: number };
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  it('needs an https:// address and a certificate it can read', () => {
    const env = { DATABASE_URL: 'postgres://atlas@localhost/atlas', ATLAS_TLS_PFX_PASSPHRASE: PASSPHRASE };
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'http://127.0.0.1:4318', ATLAS_TLS_PFX_FILE: PFX })).toThrow(
      /https:\/\//,
    );
    expect(() =>
      loadConfig({ ...env, PUBLIC_URL: 'https://127.0.0.1:4318', ATLAS_TLS_PFX_FILE: PFX + '.missing' }),
    ).toThrow(/Can't read the certificate/);
    expect(loadConfig({ ...env, PUBLIC_URL: 'https://127.0.0.1:4318', ATLAS_TLS_PFX_FILE: PFX }).tls?.pfx.length).toBe(
      2579,
    );
  });
});
