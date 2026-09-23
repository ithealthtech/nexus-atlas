import {z} from "zod";
import {getChatGPTUser} from "@/app/chatgpt-auth";
import {database,tokenHash,log} from "@/lib/storage";
import {encryptedPrivate,reportSchema,readJson,reply,type AgentRow} from "@/lib/agent-contract";
import {ingest} from "@/lib/agent-ingest";
const schema=z.discriminatedUnion("action",[
 z.object({action:z.literal("list")}),
 z.object({action:z.literal("create"),tenant:z.string().trim().min(1).max(100),name:z.string().trim().min(1).max(100),publicKey:z.string().max(1000),privateKey:encryptedPrivate}),
 z.object({action:z.literal("revoke"),id:z.string().uuid()}),
 z.object({action:z.literal("import"),report:reportSchema})
]);
export async function POST(request:Request){
 try{
 const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return reply({error:"Cross-origin request denied"},403);
 const user=await getChatGPTUser();if(!user)return reply({error:"Sign in to manage agents"},401);
 const parsed=schema.safeParse(await readJson(request));if(!parsed.success)return reply({error:"Invalid agent request"},400);
 const v=parsed.data,db=database(),owner=user.userId;
 if(v.action==="list"){const rows=await db.prepare("SELECT id,tenant,name,revoked,last_seen AS lastSeen,machine_id AS machineId,snapshot FROM agents WHERE owner=? ORDER BY created_at DESC LIMIT 1000").bind(owner).all();return reply({agents:rows.results})}
 if(v.action==="create"){
  let key:CryptoKey;try{key=await crypto.subtle.importKey("spki",Uint8Array.from(atob(v.publicKey),c=>c.charCodeAt(0)),{name:"RSA-OAEP",hash:"SHA-256"},true,["encrypt"])}catch{return reply({error:"Invalid public key"},400)}
  const algorithm=key.algorithm as RsaKeyAlgorithm;if(algorithm.modulusLength!==3072)return reply({error:"3072-bit RSA required"},400);
  const id=crypto.randomUUID(),token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(v=>v.toString(16).padStart(2,"0")).join("");
  await db.batch([db.prepare("INSERT INTO agents (id,owner,tenant,name,token_hash,public_key,private_key,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(id,owner,v.tenant,v.name,await tokenHash(token),v.publicKey,v.privateKey,new Date().toISOString()),log(db,owner,"Agent enrolled",v.tenant+" / "+v.name)]);
  return reply({config:{version:1,agentId:id,tenant:v.tenant,publicKey:v.publicKey,uploadToken:token,endpoint:null}});
 }
 if(v.action==="revoke"){const result=await db.prepare("UPDATE agents SET revoked=1 WHERE id=? AND owner=? RETURNING name").bind(v.id,owner).first<{name:string}>();if(!result)return reply({error:"Agent not found"},404);await log(db,owner,"Agent revoked",result.name).run();return reply({ok:true})}
 const agent=await db.prepare("SELECT * FROM agents WHERE id=? AND owner=?").bind(v.report.agentId,owner).first<AgentRow>();
 if(!agent)return reply({error:"Agent not found"},404);if(agent.revoked)return reply({error:"Agent revoked"},403);
 const result=await ingest(agent,v.report);return reply(result);
 }catch(e){const code=(e as Error).message;if(code==="REVOKED"||code==="MACHINE")return reply({error:code==="MACHINE"?"Enrollment belongs to a different machine":"Agent revoked"},403);if(code==="INPUT"||e instanceof SyntaxError)return reply({error:"Invalid or oversized report"},400);console.error("Agent management failed");return reply({error:"Agent storage unavailable"},503)}
}
