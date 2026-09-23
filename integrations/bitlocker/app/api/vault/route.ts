import {getChatGPTUser} from "@/app/chatgpt-auth";
import {database,log,tokenHash} from "@/lib/storage";
import {z} from "zod";
const short=z.string().trim().min(1).max(100);
const cipher=z.string().max(2048).refine(v=>{try{const c=JSON.parse(v);return c.v===1&&/^[A-Za-z0-9+/]{22}==$/.test(c.salt)&&/^[A-Za-z0-9+/]{16}$/.test(c.iv)&&typeof c.data==="string"&&/^[A-Za-z0-9+/=]+$/.test(c.data)&&c.data.length>=24&&c.data.length<=1024}catch{return false}},"Invalid encrypted record");
const input=z.discriminatedUnion("action",[
z.object({action:z.literal("list")}),
z.object({action:z.literal("add"),tenant:short,name:short,user:z.string().trim().max(100),keyId:short,cipher}),
z.object({action:z.literal("reveal"),id:z.string().regex(/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/)}),
z.object({action:z.literal("share"),id:z.string().regex(/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/),recipient:z.string().email().max(254),minutes:z.union([z.literal(15),z.literal(60),z.literal(240)]),cipher}),
z.object({action:z.literal("revoke"),id:z.string().regex(/^[a-f0-9]{64}$/)}),
z.object({action:z.literal("consume"),token:z.string().regex(/^[a-f0-9]{64}$/)})
]);
function json(data:unknown,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"}})}
export async function POST(request:Request){
try{
if(!request.headers.get("content-type")?.startsWith("application/json"))return json({error:"JSON required"},415);
const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"Cross-origin request denied"},403);
const user=await getChatGPTUser();if(!user)return json({error:"Sign in to access the vault."},401);
const body=await request.text();if(body.length>8192)return json({error:"Request too large"},413);
const parsed=input.safeParse(JSON.parse(body));if(!parsed.success)return json({error:"Invalid request. Check all required fields."},400);
const v=parsed.data,db=database(),owner=user.userId;
if(v.action==="list"){const [d,s,a]=await db.batch([db.prepare("SELECT id,tenant,name,user,key_id AS keyId,updated,CASE WHEN protection IS NULL THEN 'Protected' ELSE 'Review needed' END AS status FROM devices WHERE owner=? ORDER BY updated DESC LIMIT 1001").bind(owner),db.prepare("SELECT id,name,recipient,expires,used,revoked FROM shares WHERE owner=? ORDER BY expires DESC LIMIT 1000").bind(owner),db.prepare("SELECT id,action,detail,time FROM audit WHERE owner=? ORDER BY time DESC LIMIT 200").bind(owner)]);return json({devices:d.results,shares:s.results,audit:a.results})}
if(v.action==="add"){const id=crypto.randomUUID();await db.batch([db.prepare("INSERT INTO devices (id,owner,tenant,name,user,key_id,cipher,updated) VALUES (?,?,?,?,?,?,?,?)").bind(id,owner,v.tenant,v.name,v.user,v.keyId,v.cipher,new Date().toISOString()),log(db,owner,"Recovery key stored",v.tenant+" / "+v.name)]);return json({id})}
if(v.action==="reveal"){const d=await db.prepare("SELECT d.cipher,d.name,d.tenant,a.private_key AS privateKey FROM devices d LEFT JOIN agents a ON a.id=d.agent_id AND a.owner=d.owner WHERE d.id=? AND d.owner=?").bind(v.id,owner).first<{cipher:string;name:string;tenant:string;privateKey?:string}>();if(!d)return json({error:"Record not found"},404);await log(db,owner,"Encrypted key retrieved",d.tenant+" / "+d.name).run();return json({cipher:d.cipher,privateKey:d.privateKey})}
if(v.action==="share"){const d=await db.prepare("SELECT name FROM devices WHERE id=? AND owner=?").bind(v.id,owner).first<{name:string}>();if(!d)return json({error:"Record not found"},404);const token=Array.from(crypto.getRandomValues(new Uint8Array(32))).map(x=>x.toString(16).padStart(2,"0")).join("");const id=await tokenHash(token);await db.batch([db.prepare("INSERT INTO shares (id,owner,device_id,name,recipient,cipher,expires,used,revoked) VALUES (?,?,?,?,?,?,?,0,0)").bind(id,owner,v.id,d.name,v.recipient,v.cipher,Date.now()+v.minutes*60000),log(db,owner,"Recovery link created",d.name+" / "+v.recipient)]);return json({token})}
if(v.action==="revoke"){const row=await db.prepare("UPDATE shares SET revoked=1,cipher='' WHERE id=? AND owner=? AND revoked=0 RETURNING name").bind(v.id,owner).first<{name:string}>();if(!row)return json({error:"Share not found"},404);await log(db,owner,"Recovery link revoked",row.name).run();return json({ok:true})}
if(v.action==="consume"){const id=await tokenHash(v.token);const row=await db.prepare("UPDATE shares SET used=1 WHERE id=? AND used=0 AND revoked=0 AND expires>? RETURNING cipher,owner,name").bind(id,Date.now()).first<{cipher:string;owner:string;name:string}>();if(!row)return json({error:"This link has expired, was revoked, or has already been opened."},410);await db.batch([db.prepare("UPDATE shares SET cipher='' WHERE id=?").bind(id),log(db,row.owner,"Recovery link opened",row.name+" / "+user.email)]);return json({cipher:row.cipher,name:row.name})}
return json({error:"Unknown action"},400)
}catch(error){if(error instanceof SyntaxError)return json({error:"Invalid request"},400);console.error("Vault operation failed");return json({error:"Vault storage is temporarily unavailable. Please try again."},503)}
}

