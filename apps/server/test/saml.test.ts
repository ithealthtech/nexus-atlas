import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { SamlService, parseCertificates } from '../src/services/saml.js';
import type { StoredSaml } from '../src/services/settings.js';
import { enroll, setupOwner, signIn, startApp, OWNER, type Browser, type TestApp } from './helpers.js';
import { IDP_CERT, IDP_ISSUER, IDP_SSO_URL, OTHER_CERT, requestIdFrom, samlResponse } from './saml-idp.js';

const TEMP = 'temporary pass 1234';
const ORIGIN = 'http://localhost';

describe('SAML responses', () => {
  const saml = new SamlService(staticKeyProvider([randomBytes(32)]));
  const sp = saml.serviceProvider('https://atlas.example.com');
  const settings: StoredSaml = {
    name: 'Okta',
    entryPoint: IDP_SSO_URL,
    idpIssuer: IDP_ISSUER,
    idpCerts: parseCertificates(IDP_CERT),
    enabled: true,
    trustMfa: false,
    requireSso: false,
  };
  const answer = (id: string, over: Partial<Parameters<typeof samlResponse>[0]> = {}) =>
    samlResponse({ inResponseTo: id, acsUrl: sp.acsUrl, audience: sp.entityId, nameId: 'u-tess-001', ...over });

  it('sends the browser to the identity provider and accepts its signed answer to that request', async () => {
    const { url, cookie } = await saml.begin(settings, sp);
    expect(url.startsWith(`${IDP_SSO_URL}?SAMLRequest=`)).toBe(true);
    // The cookie is sealed: the request ID isn't readable from it.
    const id = requestIdFrom(url);
    expect(cookie).not.toContain(id);
    const who = await saml.complete(
      settings,
      sp,
      answer(id, { attributes: { email: 'Tess@Atlas.test', displayName: 'Tess Tech' } }),
      cookie,
    );
    expect(who).toEqual({ subject: 'u-tess-001', email: 'tess@atlas.test', name: 'Tess Tech' });
    // The same answer can't be used a second time.
    await expect(saml.complete(settings, sp, answer(id), cookie)).rejects.toMatchObject({ code: 'sso_expired' });
  });

  it('reads the email from the name ID or the usual claim names, and builds a name from its parts', async () => {
    const one = await saml.begin(settings, sp);
    expect(
      await saml.complete(settings, sp, answer(requestIdFrom(one.url), { nameId: 'tess@atlas.test' }), one.cookie),
    ).toEqual({ subject: 'tess@atlas.test', email: 'tess@atlas.test', name: '' });
    const two = await saml.begin(settings, sp);
    const claims = {
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'tess@atlas.test',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Tess',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'Tech',
    };
    expect(
      await saml.complete(settings, sp, answer(requestIdFrom(two.url), { attributes: claims }), two.cookie),
    ).toMatchObject({ email: 'tess@atlas.test', name: 'Tess Tech' });
  });

  it('refuses anything that is not a fresh, untampered answer from the right provider to this browser', async () => {
    const attempt = async (over: Partial<Parameters<typeof samlResponse>[0]>, useCookie = true) => {
      const { url, cookie } = await saml.begin(settings, sp);
      return saml.complete(settings, sp, answer(requestIdFrom(url), over), useCookie ? cookie : undefined);
    };
    for (const over of [
      { forged: true },
      { unsigned: true },
      { tamperNameId: 'u-owner-000' },
      { issuer: 'https://evil.example.test/saml' },
      { audience: 'https://another-app.example.com/saml' },
      { validForMinutes: -30 },
    ])
      await expect(attempt(over), JSON.stringify(over)).rejects.toMatchObject({ code: 'sso_failed' });
    // No cookie (another browser), or an answer to a different request than this browser's.
    await expect(attempt({}, false)).rejects.toMatchObject({ code: 'sso_expired' });
    const mine = await saml.begin(settings, sp);
    const theirs = await saml.begin(settings, sp);
    await expect(saml.complete(settings, sp, answer(requestIdFrom(theirs.url)), mine.cookie)).rejects.toMatchObject({
      code: 'sso_failed',
    });
    // An unsolicited answer, with no request behind it.
    await expect(saml.complete(settings, sp, answer('_made-up'), mine.cookie)).rejects.toMatchObject({
      code: 'sso_failed',
    });
    // Signed by a key Atlas wasn't given, even though the certificate is a real one.
    const wrongCert = { ...settings, idpCerts: parseCertificates(OTHER_CERT) };
    const again = await saml.begin(wrongCert, sp);
    await expect(saml.complete(wrongCert, sp, answer(requestIdFrom(again.url)), again.cookie)).rejects.toMatchObject({
      code: 'sso_failed',
    });
  });

  it('takes certificates as PEM or bare base64, and nothing else', () => {
    const bare = IDP_CERT.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    expect(parseCertificates(IDP_CERT)).toEqual([bare]);
    expect(parseCertificates(bare)).toEqual([bare]);
    expect(parseCertificates(`${IDP_CERT}\n${OTHER_CERT}`)).toHaveLength(2);
    expect(() => parseCertificates('not a certificate at all, just some words pasted in by mistake')).toThrow();
    expect(saml.metadata(sp)).toContain(`entityID="${sp.entityId}"`);
    expect(saml.metadata(sp)).toContain(`Location="${sp.acsUrl}"`);
  });
});

describe('SAML sign-in', () => {
  let t: TestApp;
  let owner: Browser;
  const sp = { entityId: `${ORIGIN}/api/auth/saml/metadata`, acsUrl: `${ORIGIN}/api/auth/saml/acs` };

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess',
      password: TEMP,
      role: 'technician',
      allClients: 'edit',
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const configure = (over: Record<string, unknown> = {}) =>
    owner.call('PUT', '/api/settings/saml', {
      name: 'Okta',
      entryPoint: IDP_SSO_URL,
      idpIssuer: IDP_ISSUER,
      idpCert: IDP_CERT,
      enabled: true,
      ...over,
    });
  /** The whole round trip, as a browser with no Atlas session: start, the provider's answer, and where it lands. */
  const signInWithSaml = async (over: Partial<Parameters<typeof samlResponse>[0]> = {}) => {
    const start = await t.app.inject({ method: 'GET', url: '/api/auth/saml/start' });
    const cookie = String(([] as string[]).concat(start.headers['set-cookie'] ?? [])[0]).split(';')[0]!;
    const body = new URLSearchParams({
      SAMLResponse: samlResponse({
        inResponseTo: requestIdFrom(String(start.headers.location)),
        acsUrl: sp.acsUrl,
        audience: sp.entityId,
        nameId: 'u-tess-001',
        attributes: { email: 'tess@atlas.test', displayName: 'Tess Tech' },
        ...over,
      }),
    }).toString();
    const back = await t.app.inject({
      method: 'POST',
      url: '/api/auth/saml/acs',
      // Posted by the identity provider's page: another origin, and marked cross-site by the browser.
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://idp.example.test',
        'sec-fetch-site': 'cross-site',
        cookie,
      },
      payload: body,
    });
    const session = ([] as string[])
      .concat(back.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0]!)
      .find((c) => c.startsWith('atlas_session=') && c.length > 'atlas_session='.length);
    return { status: back.statusCode, location: back.headers.location, session };
  };
  const stageOf = async (session: string) =>
    (await t.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: session } })).json().stage;

  it('offers the button only when it is on, and tells the provider where to post', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/saml' })).json()).toEqual({
      enabled: false,
      name: '',
      requireSso: false,
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/saml/start' })).headers.location).toBe('/?sso=off');
    const before = (await owner.call('GET', '/api/settings/saml')).data;
    expect(before).toEqual({ serviceProvider: { ...sp, metadataUrl: sp.entityId }, settings: null });

    const saved = await configure();
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data.settings.certificates[0].subject).toContain('Atlas test identity provider');
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/saml' })).json()).toEqual({
      enabled: true,
      name: 'Okta',
      requireSso: false,
    });
    const metadata = await t.app.inject({ method: 'GET', url: '/api/auth/saml/metadata' });
    expect(metadata.body).toContain(`entityID="${sp.entityId}"`);
    // Bad settings are refused with the field named.
    expect((await configure({ idpCert: 'x'.repeat(200) })).data.fields.idpCert).toBeTruthy();
    expect((await configure({ entryPoint: 'http://idp.example.test/sso' })).data.fields.entryPoint).toBeTruthy();
  });

  it('matches by email only after an administrator confirms, then signs in by name ID', async () => {
    await configure({ requireSso: true });
    const first = await signInWithSaml();
    expect(first).toMatchObject({ status: 303, location: '/?sso=pending', session: undefined });
    const people = (await owner.call('GET', '/api/users')).data as {
      id: string;
      email: string;
      saml: string | null;
      samlPending: { subject: string; email: string; name: string } | null;
    }[];
    const tess = people.find((p) => p.email === 'tess@atlas.test')!;
    expect(tess.saml).toBe('pending');
    expect(tess.samlPending).toEqual({ subject: 'u-tess-001', email: 'tess@atlas.test', name: 'Tess Tech' });

    // Not confirmed, so a second try still doesn't get in. Confirming has to name the account looked at.
    expect((await signInWithSaml()).session).toBeUndefined();
    expect((await owner.call('POST', `/api/users/${tess.id}/saml/confirm`, { subject: 'someone-else' })).status).toBe(
      409,
    );
    expect((await owner.call('POST', `/api/users/${tess.id}/saml/confirm`, { subject: 'u-tess-001' })).status).toBe(
      200,
    );

    // Now the name ID is what counts: a changed email claim for the same account still signs in.
    const ok = await signInWithSaml({ attributes: { email: 'renamed@atlas.test' } });
    expect(ok).toMatchObject({ status: 303, location: '/' });
    // Atlas's own second step still applies, since the provider's MFA isn't trusted here.
    expect(await stageOf(ok.session!)).toBe('mfa-setup');

    // Someone else at the provider with a look-alike email claim doesn't get Tess's account.
    const other = await signInWithSaml({ nameId: 'u-mallory-666', attributes: { email: 'tess@atlas.test' } });
    expect(other).toMatchObject({ location: '/?sso=conflict', session: undefined });
    // Nobody is created by signing in.
    const stranger = await signInWithSaml({ nameId: 'u-new-777', attributes: { email: 'new@atlas.test' } });
    expect(stranger).toMatchObject({ location: '/?sso=unknown', session: undefined });

    // Unlinking stops it again.
    await owner.call('DELETE', `/api/users/${tess.id}/saml`);
    expect((await signInWithSaml()).location).toBe('/?sso=pending');
  });

  it('skips Atlas’s second step only when told the provider enforces MFA, and can require single sign-on', async () => {
    await configure({ trustMfa: true, requireSso: true });
    const tess = ((await owner.call('GET', '/api/users')).data as { id: string; email: string }[]).find(
      (p) => p.email === 'tess@atlas.test',
    )!;
    await signInWithSaml();
    await owner.call('POST', `/api/users/${tess.id}/saml/confirm`, { subject: 'u-tess-001' });
    const ok = await signInWithSaml();
    expect(await stageOf(ok.session!)).toBe('active');

    // With single sign-on required, a password no longer works for staff; the owner's always does.
    const password = (email: string, pw: string) =>
      t.app.inject({ method: 'POST', url: '/api/session', payload: { email, password: pw } });
    const blocked = await password('tess@atlas.test', TEMP);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: 'sso_required' });
    expect(blocked.json().error).toContain('Okta');
    expect((await password(OWNER.email, OWNER.password)).statusCode).toBe(200);
  });

  it('refuses a forged or cross-wired response, takes the cross-site post only on its own address', async () => {
    await configure();
    for (const over of [{ forged: true }, { unsigned: true }, { issuer: 'https://evil.example.test/saml' }])
      expect(await signInWithSaml(over)).toMatchObject({ location: '/?sso=failed', session: undefined });
    // The exemption is for the response address alone: any other cross-site post is still refused.
    const elsewhere = await t.app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { origin: 'https://idp.example.test', 'sec-fetch-site': 'cross-site' },
      payload: { email: OWNER.email, password: OWNER.password },
    });
    expect(elsewhere.statusCode).toBe(403);
  });

  it('clears every link when the identity provider changes, and is for administrators only', async () => {
    await configure();
    const tess = ((await owner.call('GET', '/api/users')).data as { id: string; email: string }[]).find(
      (p) => p.email === 'tess@atlas.test',
    )!;
    await signInWithSaml();
    await owner.call('POST', `/api/users/${tess.id}/saml/confirm`, { subject: 'u-tess-001' });
    // The same provider saved again keeps links; a different issuer drops them.
    expect((await configure({ name: 'Okta SSO' })).data.linksCleared).toBe(false);
    // The certificate can be left out to keep the saved one.
    const kept = await configure({ name: 'Okta', idpCert: undefined });
    expect(kept.status).toBe(200);
    expect(kept.data.settings.certificates).toHaveLength(1);
    expect((await configure({ idpIssuer: 'https://new-idp.example.test/saml' })).data.linksCleared).toBe(true);
    const after = ((await owner.call('GET', '/api/users')).data as { id: string; saml: string | null }[]).find(
      (p) => p.id === tess.id,
    )!;
    expect(after.saml).toBeNull();

    const { b: tech } = await signIn(t.app, 'tess@atlas.test', TEMP);
    await tech.call('POST', '/api/account/password', { current: TEMP, next: 'cobalt fresh pass 12' });
    await enroll(tech);
    expect((await tech.call('GET', '/api/settings/saml')).status).toBe(403);
    expect((await tech.call('PUT', '/api/settings/saml', {})).status).toBe(403);
    expect((await owner.call('DELETE', '/api/settings/saml')).status).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/saml' })).json().enabled).toBe(false);
  });
});
