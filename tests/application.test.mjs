import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openStore } from '../server/store.mjs';
import { createApp, demoActors } from '../server/app.mjs';
import { bitlockerInventory } from '../server/bitlocker.mjs';

const tech = demoActors.technician; const viewer = demoActors.client;
const other = {id:'other',name:'Other MSP',role:'editor',mspId:'other-msp',clientIds:null};
const document = (extra = {}) => ({title:'Synthetic runbook',category:'Runbook',content:'# Step 1\nTest only.',status:'Draft',review_date:'2026-10-31',...extra});
const denied = status => error => error.status === status;

test('client and MSP scope covers lists, detail, search, activity and exports', () => {
  const s = openStore();
  try {
    assert.equal(s.listClients(tech).length,4); assert.equal(s.listClients(viewer).length,1); assert.equal(s.listClients(other).length,1);
    assert.ok(s.listRecords(viewer).every(r => r.client_id === 'harbor'));
    assert.equal(s.listRecords(viewer,'','Northline').length,0);
    assert.ok(s.activity(viewer).every(r => r.client_id === 'harbor'));
    assert.throws(() => s.detail(viewer,'northline-nas'),denied(404));
    assert.throws(() => s.detail(tech,'private-record'),denied(404));
    assert.throws(() => s.listRecords(viewer,'cedar'),denied(404));
    assert.throws(() => s.exportClient(tech,'private-client'),denied(404));
    assert.throws(() => s.exportClient(viewer,'harbor'),denied(403));
    const exported = s.exportClient(tech,'harbor');
    assert.equal(exported.records.length,5); assert.ok(exported.revisions.every(v => exported.records.some(r => r.id === v.record_id)));
    assert.equal(exported.relationships.length,1);
  } finally { s.close(); }
});
test('read-only identity cannot create, change, link, restore, or export', () => {
  const s = openStore();
  try {
    for (const operation of [() => s.createClient(viewer,{name:'Blocked'}),() => s.createRecord(viewer,'harbor','document',document()),
      () => s.saveRecord(viewer,'harbor-wan',document({version:1})),() => s.restore(viewer,'harbor-wan',1,1),
      () => s.link(viewer,'harbor-wan','harbor-server'),() => s.exportClient(viewer,'harbor')]) assert.throws(operation,denied(403));
  } finally { s.close(); }
});
test('revision restore appends history; stale updates are rejected without writes', () => {
  const s = openStore();
  try {
    const record = s.createRecord(tech,'harbor','document',document());
    const changed = s.saveRecord(tech,record.id,document({version:1,content:'Changed text'}));
    assert.equal(changed.version,2);
    assert.throws(() => s.saveRecord(tech,record.id,document({version:1})),denied(409));
    assert.throws(() => s.restore(tech,record.id,1,1),denied(409));
    const restored = s.restore(tech,record.id,1,2);
    assert.equal(restored.content,record.content); assert.equal(restored.version,3);
    assert.deepEqual(s.detail(tech,record.id).revisions.map(r => r.version),[3,2,1]);
  } finally { s.close(); }
});
test('relationships validate both endpoints and never cross client boundaries', () => {
  const s = openStore();
  try {
    assert.throws(() => s.link(tech,'harbor-wan','private-record'),denied(404));
    assert.throws(() => s.link(tech,'harbor-wan','northline-nas'),denied(400));
    assert.throws(() => s.link(tech,'harbor-wan','harbor-wan'),denied(400));
    s.link(tech,'harbor-server','harbor-wan'); s.link(tech,'harbor-wan','harbor-server');
    assert.equal(s.detail(tech,'harbor-server').linked.length,1);
  } finally { s.close(); }
});
test('validation rejects unexpected secret fields, invalid dates and oversized content', () => {
  const s = openStore();
  try {
    for (const body of [document({password:'synthetic'}),document({review_date:'2026-02-30'}),document({title:''}),document({status:'invented'}),document({content:'x'.repeat(30001)})]) {
      assert.throws(() => s.createRecord(tech,'harbor','document',body),denied(400));
    }
  } finally { s.close(); }
});
test('saved clients, assets, documents and revisions survive database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(),'atlas-store-test-')); const path = join(directory,'test.sqlite'); let s;
  try {
    s = openStore(path); const client = s.createClient(tech,{name:'Persistence test',industry:'Testing'});
    const r = s.createRecord(tech,client.id,'asset',document({title:'TEST-ASSET'}));
    s.saveRecord(tech,r.id,document({title:'TEST-ASSET',content:'Persistent content',version:1}));
    s.close(); s = openStore(path);
    assert.equal(s.client(tech,client.id).name,'Persistence test'); assert.equal(s.detail(tech,r.id).content,'Persistent content');
    assert.equal(s.detail(tech,r.id).revisions.length,2);
  } finally { s?.close(); rmSync(directory,{recursive:true,force:true}); }
});
test('BitLocker sample inventory follows asset scope without storing recovery keys', () => {
  const s = openStore();
  try {
    assert.equal(bitlockerInventory(s,tech).length,2); assert.equal(bitlockerInventory(s,viewer).length,1);
    assert.equal(bitlockerInventory(s,other).length,0);
    assert.throws(() => bitlockerInventory(s,viewer,'northline'),denied(404));
    assert.ok(bitlockerInventory(s,tech).every(r => r.sample && r.recovery === 'Not collected'));
    assert.doesNotMatch(JSON.stringify(bitlockerInventory(s,tech)),/cipher|privateKey|password|uploadToken/);
  } finally { s.close(); }
});
test('HTTP session, CSRF, origin, scope, secret-storage gates and static allowlist', async () => {
  const store = openStore(); const server = createApp(store);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(base+path,options);
  try {
    assert.equal((await call('/api/records')).status,401);
    assert.equal((await call('/api/records',{headers:{'oai-authenticated-user-email':'forged@example.invalid'}})).status,401);
    assert.equal((await call('/api/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:'{"persona":"technician"}'})).status,403);
    const badHostStatus = await new Promise((resolve,reject) => {
      const req = request(`${base}/health`,{headers:{Host:'evil.example'}},res => { res.resume(); resolve(res.statusCode); });
      req.on('error',reject); req.end();
    });
    assert.equal(badHostStatus,403);
    assert.equal((await call('/server/store.mjs')).status,401);
    const login = await call('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"persona":"client"}'});
    assert.equal(login.status,200); assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
    const session = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = {Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
    const records = await (await call('/api/records',{headers})).json(); assert.ok(records.every(r => r.client_id === 'harbor'));
    assert.equal((await call('/api/records/northline-nas',{headers})).status,404);
    assert.equal((await call('/api/clients',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await call('/api/clients',{method:'POST',headers,body:'{"name":"forbidden"}'})).status,403);
    for (const path of ['/api/vault','/api/vault/items','/api/bitlocker/enrollments','/api/agents','/api/bitlocker/reveal','/api/bitlocker/share','/api/bitlocker/import']) assert.equal((await call(path,{method:'POST',headers,body:'{}'})).status,501);
    for (const path of ['/api/agent-ingest','/api/bitlocker/ingest']) assert.equal((await call(path,{method:'POST',headers,body:'{}'})).status,503);
    assert.equal((await call('/api/bitlocker',{headers})).status,200);
    assert.equal((await call('/api/session',{method:'DELETE',headers})).status,200);
    assert.equal((await call('/api/records',{headers})).status,401);
    const html = await call('/'); assert.equal(html.status,200); assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
});
test('production startup fails closed', () => {
  const previous = process.env.NODE_ENV; const s = openStore();
  try { process.env.NODE_ENV='production'; assert.throws(() => createApp(s),/cannot run in production/); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous; s.close(); }
});
