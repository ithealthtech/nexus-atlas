import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {generateAgentKeys,decrypt} from "../lib/crypto.ts";
const path=await mkdtemp(join(tmpdir(),"keyhaven-fixture-"));
const password=Array(8).fill("123453").join("-"),pass="synthetic-only-passphrase";
const keys=await generateAgentKeys(pass);
const config={version:1,agentId:crypto.randomUUID(),publicKey:keys.publicKey,uploadToken:"c".repeat(64),endpoint:null};
const fixture=join(path,"fixture.json"),output=join(path,"report.json");
await writeFile(fixture,JSON.stringify({password,config}));
const result=spawnSync("pwsh",["-NoProfile","-File","tests/collector.ps1","-FixturePath",fixture,"-OutputPath",output],{encoding:"utf8",timeout:60000});
assert.equal(result.status,0,result.stdout+result.stderr);
const report=JSON.parse(await readFile(output,"utf8"));
for(const p of report.volumes[0].protectors){
 const cipher=JSON.stringify({v:2,algorithm:"RSA-OAEP-256",data:p.cipher});
 assert.equal(await decrypt(cipher,pass,keys.privateKey),password);
 await assert.rejects(()=>decrypt(cipher,"wrong-passphrase",keys.privateKey));
}
console.log(result.stdout.trim());
console.log("PASS: PowerShell RSA ciphertext decrypts in browser-compatible WebCrypto; wrong passphrase rejected.");
