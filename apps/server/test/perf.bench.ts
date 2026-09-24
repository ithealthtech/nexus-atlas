// Performance check against a large MSP: npm run perf -w @atlas/server (needs TEST_DATABASE_URL).
// Loads 2,000 clients with 40,000 assets, 10,000 documents, 20,000 passwords, 20,000 contacts, 200,000 activity
// entries and 20,000 security events, then times the busiest requests as the owner and as a technician.
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { setupOwner, signIn, enroll, startApp } from './helpers.js';

const CLIENTS = Number(process.env.PERF_CLIENTS ?? 2000);
const t = await startApp();
const db = t.handle.db;
try {
  const owner = (await setupOwner(t.app)).b;
  const started = performance.now();
  const [{ org, layout }] = (
    await db.execute(
      sql`select o.id as org, (select id from asset_layouts where org_id = o.id and key = 'configuration') as layout from orgs o`,
    )
  ).rows as { org: string; layout: string }[];
  await db.execute(sql`
    insert into clients (org_id, name, type, notes)
    select ${org}, 'Client ' || lpad(g::text, 5, '0'), 'Customer', 'Sample client ' || g from generate_series(1, ${CLIENTS}) g`);
  await db.execute(sql`
    insert into assets (org_id, client_id, layout_id, name, fields, notes)
    select c.org_id, c.id, ${layout}, c.name || ' PC-' || g,
      jsonb_build_object('ip_address', '10.' || (g % 250) || '.0.' || (g % 200), 'serial', 'SN' || md5(c.id::text || g),
        'warranty_expires', to_char(current_date + ((abs(hashtext(c.id::text || g)) % 730) - 30), 'YYYY-MM-DD')), ''
    from clients c, generate_series(1, 20) g`);
  await db.execute(sql`
    insert into documents (org_id, client_id, title, content, content_text)
    select c.org_id, c.id, 'Runbook ' || g || ' for ' || c.name, '{"type":"doc","content":[]}'::jsonb,
      'Steps to restart the firewall and check the backup job for ' || c.name
    from clients c, generate_series(1, 5) g`);
  await db.execute(sql`
    insert into contacts (org_id, client_id, name, email)
    select c.org_id, c.id, 'Person ' || g || ' ' || c.name, 'p' || g || '@' || replace(lower(c.name), ' ', '') || '.test'
    from clients c, generate_series(1, 10) g`);
  await db.execute(sql`
    insert into passwords (org_id, client_id, name, username, secret, fingerprint, strength, restricted)
    select c.org_id, c.id, 'Login ' || g, 'admin', 'v2:none', md5(c.id::text || g), 3, g = 10
    from clients c, generate_series(1, 10) g`);
  await db.execute(sql`
    insert into activity (org_id, client_id, actor_name, action, entity_type, entity_id, title)
    select c.org_id, c.id, 'Alex', 'Updated', case when g % 10 = 0 then 'password' else 'asset' end,
      case when g % 10 = 0 then (select id from passwords p where p.client_id = c.id limit 1) else c.id end, 'Item ' || g
    from clients c, generate_series(1, ${Math.round(200_000 / CLIENTS)}) g`);
  await db.execute(sql`
    insert into security_events (org_id, actor, action, detail, ip)
    select ${org}, 'Alex', 'Signed in', 'Password and app', '10.0.0.' || (g % 250) from generate_series(1, 20000) g`);
  await db.execute(sql`analyze`);
  console.log(`Loaded in ${((performance.now() - started) / 1000).toFixed(1)} s`);

  // A technician with edit + passwords on every client, not listed on the restricted passwords.
  await owner.call('POST', '/api/users', {
    email: 'tech@atlas.test',
    name: 'Tess Tech',
    role: 'technician',
    allClients: 'edit_passwords',
    password: 'temporary pass 1234',
  });
  const tech = (await signIn(t.app, 'tech@atlas.test', 'temporary pass 1234')).b;
  await tech.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
  await enroll(tech);

  const one = (
    (await db.execute(sql`select id from clients order by name offset 777 limit 1`)).rows[0] as { id: string }
  ).id;
  const cases: [string, string][] = [
    ['Clients list', '/api/clients'],
    ['One client', `/api/clients/${one}`],
    ["A client's assets", `/api/assets?client=${one}`],
    ["A client's passwords", `/api/passwords?client=${one}`],
    ['Search: name', '/api/search?q=Client%2001234'],
    ['Search: IP address', '/api/search?q=10.42.0.7'],
    ['Search: document text', '/api/search?q=firewall%20backup'],
    ['Activity feed', '/api/activity?limit=50'],
    ["A client's activity", `/api/activity?client=${one}&limit=50`],
    ['Expirations (90 days)', '/api/expirations?days=90'],
    ['Knowledge base', '/api/documents?client=global'],
    ['Security log', '/api/security-events'],
    ['System status', '/api/status'],
  ];
  const rows: string[] = [];
  for (const [label, url] of cases)
    for (const [who, b] of [
      ['owner', owner],
      ['technician', tech],
    ] as const) {
      if (who === 'technician' && /security-events|status/.test(url)) continue;
      await b.call('GET', url); // warm-up
      const times: number[] = [];
      let status = 0;
      for (let i = 0; i < 5; i++) {
        const s = performance.now();
        status = (await b.call('GET', url)).status;
        times.push(performance.now() - s);
      }
      times.sort((x, y) => x - y);
      rows.push(`| ${label} | ${who} | ${status} | ${times[2]!.toFixed(0)} ms | ${times[4]!.toFixed(0)} ms |`);
    }
  console.log('\n| Request | As | Status | Median | Slowest of 5 |\n|---|---|---|---|---|');
  console.log(rows.join('\n'));
} finally {
  await t.close();
}
