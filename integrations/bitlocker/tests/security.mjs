import assert from "node:assert/strict";
import {localPost} from "./http.mjs";
import {encrypt,decrypt} from "../lib/crypto.ts";
const base=process.env.TEST_URL||"http://127.0.0.1:4188";
const owner="test-"+crypto.randomUUID(),other="other-"+crypto.randomUUID();
async function api(action,data={},user=owner,origin=base){return localPost(base+"/api/vault",{"content-type":"application/json",origin,...(user?{"oai-authenticated-user-id":user,"oai-authenticated-user-email":user+"@example.test"}:{})},{action,...data})}
const pass="local-test-only-passphrase";
const recovery=Array(8).fill("123453").join("-");
const cipher=await encrypt(recovery,pass);
assert.equal(await decrypt(cipher,pass),recovery);
assert.notEqual(await encrypt(recovery,pass),cipher);
await assert.rejects(()=>decrypt(cipher,"incorrect-passphrase"));
assert.equal((await api("list",{},"")).status,401);
assert.equal((await api("list",{},owner,"https://untrusted.example")).status,403);
assert.equal((await api("add",{cipher:"plaintext"})).status,400);
const added=await api("add",{tenant:"Test client A",name:"QA-001",user:"Test user",keyId:"test-key-id",cipher});
assert.equal(added.status,200);
const id=added.body.id;
const inventory=await api("list");
assert.equal(inventory.body.devices.length,1);
assert.ok(!JSON.stringify(inventory.body).includes(cipher));
assert.ok(!JSON.stringify(inventory.body).includes(recovery));
assert.equal((await api("list",{},other)).body.devices.length,0);
assert.equal((await api("reveal",{id},other)).status,404);
assert.equal((await api("share",{id,recipient:"qa@example.test",minutes:15,cipher},other)).status,404);
assert.equal(await decrypt((await api("reveal",{id})).body.cipher,pass),recovery);
const shared=await api("share",{id,recipient:"qa@example.test",minutes:15,cipher});
assert.equal(shared.status,200);
const consume=await Promise.all([api("consume",{token:shared.body.token},other),api("consume",{token:shared.body.token},other)]);
assert.deepEqual(consume.map(x=>x.status).sort(),[200,410]);
const second=await api("share",{id,recipient:"qa@example.test",minutes:15,cipher});
const listing=await api("list");
const active=listing.body.shares.find(s=>!s.used&&!s.revoked);
assert.equal((await api("revoke",{id:active.id},other)).status,404);
assert.equal((await api("revoke",{id:active.id})).status,200);
assert.equal((await api("consume",{token:second.body.token})).status,410);
assert.equal((await api("share",{id,recipient:"qa@example.test",minutes:999,cipher})).status,400);
assert.ok((await api("list")).body.audit.length>=5);
console.log("PASS: encryption, wrong passphrase, randomized ciphertext, authentication, origin checks, workspace isolation, masked inventory, atomic single-use, revocation, expiry validation, audit.");



