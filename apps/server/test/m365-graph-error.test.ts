import { describe, expect, it } from 'vitest';
import { M365Client } from '../src/services/integrations/m365.js';
import { graphErrorDetail } from '../src/services/integrations/m365-graph-error.js';

const REQUEST = '11111111-2222-3333-4444-555555555555';
const json = (body: unknown, status = 400, headers?: HeadersInit) => Response.json(body, { status, headers });

describe('Microsoft Graph error diagnostics', () => {
  it('identifies an unsupported query and its Microsoft request ID', async () => {
    const detail = await graphErrorDetail(
      json({ error: { code: 'Request_UnsupportedQuery', message: 'arbitrary upstream text' } }, 400, {
        'request-id': REQUEST,
      }),
    );
    expect(detail).toBe(
      ` Microsoft code Request_UnsupportedQuery. Microsoft does not support this query. Microsoft request ID ${REQUEST}.`,
    );
    expect(detail).not.toContain('arbitrary');
  });

  it.each([
    ['Unsupported query.', 'does not support this query'],
    ['Query is not supported.', 'does not support this query'],
    ['Invalid filter clause.', 'query syntax or selected fields'],
    ['Syntax error at position 4.', 'query syntax or selected fields'],
    ['Unknown failure.', 'rejected the request as invalid'],
  ])('classifies a broad bad request without copying its message: %s', async (message, explanation) => {
    const detail = await graphErrorDetail(json({ error: { code: 'Request_BadRequest', message } }));
    expect(detail).toContain('Microsoft code Request_BadRequest');
    expect(detail).toContain(explanation);
    expect(detail).not.toContain(message);
  });

  it('never copies secrets, tokens, nested details, HTML or unknown codes into a saved diagnostic', async () => {
    const secret = 'opaque-client-secret';
    const refresh = 'opaque-refresh-token';
    const bearer = 'eyJhbGciOiJSUzI1NiJ9.eyJzZWNyZXQiOiJ2YWx1ZSJ9.signature';
    const body = {
      error: {
        code: 'Request_BadRequest',
        message: `Unsupported query. client_secret=${secret} refresh_token=${refresh} Bearer ${bearer} technician@customer.test <script>alert(1)</script>`,
        innerError: { 'request-id': REQUEST, stack: secret, access_token: bearer },
        details: [{ message: refresh }],
      },
    };
    const detail = await graphErrorDetail(json(body));
    expect(detail).toContain('does not support this query');
    expect(detail).toContain(REQUEST);
    for (const value of [secret, refresh, bearer, 'customer.test', '<script>', 'client_secret', 'access_token'])
      expect(detail).not.toContain(value);
    expect(await graphErrorDetail(json({ error: { code: secret, message: refresh } }))).toBe('');
    expect(await graphErrorDetail(json({ error: { code: 'constructor', message: secret } }))).toBe('');
    expect(
      (await graphErrorDetail(json({ error: { code: 'Request_BadRequest', message: secret + 'x'.repeat(100_000) } })))
        .length,
    ).toBeLessThan(300);
  });

  it.each([null, [], 'not an object', { error: null }, { error: { code: 400, message: {} } }])(
    'handles malformed JSON error shapes: %j',
    async (body) => {
      expect(await graphErrorDetail(json(body))).toBe('');
    },
  );

  it('handles non-JSON errors and refuses unvalidated request IDs', async () => {
    expect(await graphErrorDetail(new Response('<html>opaque-secret</html>', { status: 502 }))).toBe('');
    expect(
      await graphErrorDetail(
        json({ error: { innerError: { 'request-id': 'opaque-secret' } } }, 400, { 'request-id': 'another-secret' }),
      ),
    ).toBe('');
  });

  it.each([400, 401, 403, 429, 503])('adds safe diagnostics to the Graph client for HTTP %i', async (status) => {
    const fetcher = (async () =>
      json({ error: { code: 'Request_BadRequest', message: 'Unsupported query.' } }, status, {
        'request-id': REQUEST,
      })) as typeof fetch;
    const client = new M365Client('app', 'secret', fetcher, async () => 'opaque-access-token');
    await expect(client.check('customer')).rejects.toThrow('Microsoft code Request_BadRequest');
    await expect(client.check('customer')).rejects.toThrow(REQUEST);
    if ([401, 403].includes(status)) await expect(client.check('customer')).rejects.toThrow('GDAP group assignment');
    else
      await expect(client.check('customer')).rejects.toThrow(`Microsoft Graph answered ${status} for /organization.`);
  });
});
