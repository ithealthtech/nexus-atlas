import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Problem extends Error {
  constructor(status, message, headers) { super(message); this.status = status; this.headers = headers; }
}
const fail = (status, message) => { throw new Problem(status, message); };
function text(value, label, max = 200, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `${label} is required and must be under ${max + 1} characters.`);
  return value.trim();
}
function fields(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'An object is required.');
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Unexpected field. Credentials are not supported by this release.');
}
const now = () => new Date().toISOString();

export function openStore(filename = ':memory:') {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, msp_id TEXT NOT NULL, name TEXT NOT NULL, industry TEXT NOT NULL,
      contact TEXT NOT NULL, email TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), kind TEXT NOT NULL CHECK(kind IN ('asset','document')),
      title TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', review_date TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS revisions (
      record_id TEXT NOT NULL REFERENCES records(id), version INTEGER NOT NULL,
      snapshot TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(record_id, version)
    );
    CREATE TABLE IF NOT EXISTS relationships (
      source_id TEXT NOT NULL REFERENCES records(id), target_id TEXT NOT NULL REFERENCES records(id),
      PRIMARY KEY(source_id, target_id), CHECK(source_id <> target_id)
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), actor TEXT NOT NULL,
      action TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_version VALUES (1);
  `);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function audit(actor, clientId, action, title) {
    run('INSERT INTO activity VALUES (?,?,?,?,?,?)', randomUUID(), clientId, actor.name, action, title, now());
  }
  function snapshot(record, actor) {
    run('INSERT INTO revisions VALUES (?,?,?,?,?)', record.id, record.version, JSON.stringify(record), actor.name, now());
  }
  function client(actor, id) {
    const row = get('SELECT * FROM clients WHERE id=? AND msp_id=?', id, actor.mspId);
    if (!row || (actor.clientIds && !actor.clientIds.includes(id))) fail(404, 'Client not found.');
    return row;
  }
  function record(actor, id) {
    const row = get('SELECT * FROM records WHERE id=?', id);
    if (!row) fail(404, 'Record not found.');
    client(actor, row.client_id);
    return row;
  }
  function writer(actor) { if (actor.role !== 'admin' && actor.role !== 'technician') fail(403, 'This account has read-only access.'); }
  function listClients(actor) {
    return all(`SELECT c.*, (SELECT COUNT(*) FROM records r WHERE r.client_id=c.id AND r.kind='asset') AS assets,
      (SELECT COUNT(*) FROM records r WHERE r.client_id=c.id AND r.kind='document') AS documents
      FROM clients c WHERE msp_id=? ORDER BY name`, actor.mspId).filter(c => !actor.clientIds || actor.clientIds.includes(c.id));
  }
  function listRecords(actor, clientId = '', query = '') {
    if (clientId) client(actor, clientId);
    const allowed = new Set(listClients(actor).map(c => c.id));
    const search = query.toLocaleLowerCase();
    return all(`SELECT r.*, c.name AS client_name FROM records r JOIN clients c ON c.id=r.client_id WHERE c.msp_id=? ORDER BY r.updated_at DESC`, actor.mspId)
      .filter(r => allowed.has(r.client_id) && (!clientId || r.client_id === clientId))
      .filter(r => !search || `${r.title} ${r.category} ${r.content} ${r.address} ${r.client_name}`.toLocaleLowerCase().includes(search));
  }
  function validatedRecord(body) {
    fields(body, ['title','category','content','status','address','review_date','version']);
    const value = {
      title: text(body.title, 'Title'), category: text(body.category, 'Category', 80),
      content: text(body.content ?? '', 'Content', 30000, false),
      status: text(body.status ?? 'Current', 'Status', 30),
      address: text(body.address ?? '', 'Address', 200, false),
      review_date: text(body.review_date ?? '', 'Review date', 10, false)
    };
    if (!['Current','Needs review','Draft'].includes(value.status)) fail(400, 'Choose a valid status.');
    if (value.review_date && (!/^\d{4}-\d{2}-\d{2}$/.test(value.review_date) || !Number.isFinite(Date.parse(value.review_date)) || new Date(value.review_date).toISOString().slice(0,10) !== value.review_date)) fail(400, 'Choose a valid review date.');
    return value;
  }
  function saveRecord(actor, id, body) {
    writer(actor);
    const existing = record(actor, id);
    const value = validatedRecord(body);
    if (!Number.isInteger(body.version) || body.version !== existing.version) fail(409, 'This record changed. Reopen it before saving your changes.');
    return transaction(() => {
      run(`UPDATE records SET title=?, category=?, content=?, status=?, address=?, review_date=?, version=version+1, updated_at=? WHERE id=?`,
        value.title, value.category, value.content, value.status, value.address, value.review_date, now(), id);
      const updated = record(actor, id);
      snapshot(updated, actor); audit(actor, existing.client_id, 'Updated', value.title);
      return updated;
    });
  }
  function seed() {
    if (get('SELECT COUNT(*) AS count FROM clients').count) return;
    transaction(() => {
      const demo = { name: 'Atlas sample data' };
      const companies = [
        ['harbor','msp-demo','Harbor Dental Group','Healthcare','Morgan Ellis','morgan@harbor.example','#3978dc'],
        ['northline','msp-demo','Northline Architecture','Professional services','Alex Chen','alex@northline.example','#8a63d2'],
        ['cedar','msp-demo','Cedar & Co.','Financial services','Jordan Lane','jordan@cedar.example','#b57632'],
        ['summit','msp-demo','Summit Manufacturing','Manufacturing','Taylor Brooks','taylor@summit.example','#278675'],
        ['private-client','other-msp','Isolation Test Company','Testing','Test','test@example.invalid','#64748b']
      ];
      for (const c of companies) run('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?)', ...c, now());
      const entries = [
        ['harbor-firewall','harbor','asset','HDG-FW-01','Firewall','Primary gateway at the downtown office.\n\nWAN handoff: fiber circuit in the network cabinet.\nSupport: link the WAN outage procedure before making changes.','Current','10.20.0.1',''],
        ['harbor-switch','harbor','asset','HDG-SW-01','Network switch','Main access switch. Rack A, position 08.\nVLAN 10: workstations\nVLAN 20: voice\nVLAN 30: guest Wi-Fi','Current','10.20.0.2',''],
        ['harbor-server','harbor','asset','HDG-DC-01','Server','Directory and DNS server.\nBackup verification is documented in the daily backup checklist.','Needs review','10.20.0.10','2026-10-01'],
        ['harbor-wan','harbor','document','Internet outage response','Runbook','# Before you begin\nConfirm the scope of the outage with the front desk. Record the incident in the PSA.\n\n# 1. Check the local network\nVerify gateway reachability and switch uplinks. Check whether voice and guest networks are affected.\n\n# 2. Check the circuit\nInspect the ONT indicators. Contact the carrier using the approved support contact. Do not reset the firewall without approval.\n\n# 3. Restore and verify\nConfirm workstations, phones, and business applications reconnect. Record findings and update the incident.','Current','','2026-10-15'],
        ['harbor-onboard','harbor','document','New employee onboarding','Checklist','# Preparation\nConfirm manager approval, start date, and required applications.\n\n# Account setup\nCreate the approved identity and assign least-privilege groups. Enroll MFA with the employee.\n\n# Handoff\nVerify the workstation, email, and printing. Record completion in the service ticket.','Current','','2026-10-10'],
        ['northline-nas','northline','asset','NLA-NAS-01','Storage','Project file storage. Rack B, position 04.\nConfirm backup and retention requirements with the project lead.','Current','10.30.0.20',''],
        ['northline-backup','northline','document','Daily backup verification','Checklist','# Review backup jobs\nCheck overnight job status and investigate failures.\n\n# Validate recovery\nFollow the approved restore-test schedule. Record evidence in the ticket.','Needs review','','2026-09-30'],
        ['cedar-cloud','cedar','asset','Microsoft 365 tenant','Cloud service','Business productivity tenant.\nIdentity changes require the client administrator’s approval.','Current','cedar.example',''],
        ['cedar-offboard','cedar','document','Employee offboarding','Runbook','# Confirm authorization\nVerify the request with the designated approver.\n\n# Secure access\nRevoke sessions and remove access according to the approved change. Preserve records under the retention policy.','Draft','',''],
        ['summit-fw','summit','asset','SM-FW-01','Firewall','Plant gateway. Changes must be coordinated with the operations manager.','Current','10.40.0.1',''],
        ['summit-network','summit','document','Network overview','Reference','# Network segments\nOffice: VLAN 10\nProduction: VLAN 50\nGuest: VLAN 90\n\n# Change coordination\nConfirm the maintenance window with the plant manager before modifying production connectivity.','Current','','2026-11-01'],
        ['private-record','private-client','document','Private tenant record','Reference','Isolation test fixture.','Current','','']
      ];
      for (const e of entries) {
        run('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)', ...e, 1, now());
        snapshot(get('SELECT * FROM records WHERE id=?', e[0]), demo);
      }
      run('INSERT INTO relationships VALUES (?,?)', 'harbor-firewall','harbor-wan');
      run('INSERT INTO relationships VALUES (?,?)', 'northline-nas','northline-backup');
      for (const c of companies) audit(demo, c[0], 'Added sample workspace', c[2]);
    });
  }
  seed();
  return {
    close: () => db.close(), db, transaction, listClients, listRecords,
    client,
    detail(actor, id) {
      const value = record(actor, id);
      const linked = all(`SELECT r.* FROM records r JOIN relationships l ON
        (l.source_id=? AND l.target_id=r.id) OR (l.target_id=? AND l.source_id=r.id)`, id, id)
        .filter(r => r.client_id === value.client_id);
      const revisions = all('SELECT version, actor, created_at FROM revisions WHERE record_id=? ORDER BY version DESC', id);
      return { ...value, linked, revisions };
    },
    createClient(actor, body) {
      writer(actor); if (actor.clientIds) fail(403, 'MSP-wide access is required.');
      fields(body, ['name','industry','contact','email']);
      const value = { id: randomUUID(), name: text(body.name, 'Client name'), industry: text(body.industry || 'General', 'Industry', 80),
        contact: text(body.contact || '', 'Contact', 200, false), email: text(body.email || '', 'Email', 254, false) };
      if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) fail(400, 'Enter a valid email address.');
      return transaction(() => {
        run('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?)', value.id, actor.mspId, value.name, value.industry, value.contact, value.email, '#3978dc', now());
        audit(actor, value.id, 'Created client', value.name); return client(actor, value.id);
      });
    },
    createRecord(actor, clientId, kind, body) {
      writer(actor); client(actor, clientId);
      if (!['asset','document'].includes(kind)) fail(400, 'Unsupported record type.');
      const value = validatedRecord(body); const id = randomUUID();
      return transaction(() => {
        run('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, clientId, kind, value.title, value.category, value.content, value.status, value.address, value.review_date, 1, now());
        const created = record(actor, id); snapshot(created, actor); audit(actor, clientId, 'Created', value.title); return created;
      });
    },
    saveRecord,
    restore(actor, id, version, expectedVersion) {
      writer(actor); const current = record(actor, id);
      const revision = get('SELECT snapshot FROM revisions WHERE record_id=? AND version=?', id, version);
      if (!revision) fail(404, 'Revision not found.');
      const old = JSON.parse(revision.snapshot);
      const { title, category, content, status, address, review_date } = old;
      // Restoring appends a new revision; earlier history is preserved.
      return saveRecord(actor, current.id, { title, category, content, status, address, review_date, version: expectedVersion });
    },
    link(actor, sourceId, targetId) {
      writer(actor); const source = record(actor, sourceId); const target = record(actor, targetId);
      if (source.client_id !== target.client_id || sourceId === targetId) fail(400, 'Link two different records in the same client workspace.');
      const ids = [sourceId, targetId].sort();
      transaction(() => {
        if (get('SELECT 1 FROM relationships WHERE (source_id=? AND target_id=?) OR (source_id=? AND target_id=?)', ...ids, ids[1], ids[0])) return;
        run('INSERT INTO relationships VALUES (?,?)', ...ids); audit(actor, source.client_id, 'Linked records', `${source.title} / ${target.title}`);
      });
      return { ok: true };
    },
    activity(actor, clientId = '') {
      if (clientId) client(actor, clientId);
      const allowed = new Set(listClients(actor).map(c => c.id));
      return all(`SELECT a.*, c.name AS client_name FROM activity a JOIN clients c ON c.id=a.client_id WHERE c.msp_id=? ORDER BY a.created_at DESC`, actor.mspId)
        .filter(a => allowed.has(a.client_id) && (!clientId || a.client_id === clientId)).slice(0,100);
    },
    exportClient(actor, id) {
      writer(actor); const company = client(actor, id);
      return transaction(() => {
        const records = listRecords(actor, id);
        const revisions = records.flatMap(r => all('SELECT * FROM revisions WHERE record_id=? ORDER BY version', r.id));
        const relationships = all('SELECT l.* FROM relationships l JOIN records r ON r.id=l.source_id WHERE r.client_id=?', id);
        audit(actor, id, 'Exported documentation', company.name);
        return { format: 'atlas-documentation-v1', exportedAt: now(), client: company, records, revisions, relationships };
      });
    }
  };
}
