import {z} from "zod";
const text=z.string().trim().min(1).max(200);
export const encryptedPrivate=z.string().max(10000).refine(v=>{try{const c=JSON.parse(v);return c.v===1&&typeof c.data==="string"&&c.data.length>1000&&c.data.length<9000&&/^[A-Za-z0-9+/]{22}==$/.test(c.salt)&&/^[A-Za-z0-9+/]{16}$/.test(c.iv)}catch{return false}});
export const reportSchema=z.object({
 version:z.literal(1),reportId:z.string().uuid(),agentId:z.string().uuid(),
 collectedAt:z.string().datetime().transform(v=>new Date(v).toISOString()),machineId:z.string().uuid(),hostname:text,
 os:z.string().max(200),serialNumber:z.string().max(100),
 volumes:z.array(z.object({
  volumeId:text,mountPoint:z.string().max(50),protection:z.enum(["On","Off","Unknown"]),
  encryptionMethod:z.string().max(80),encryptionPercentage:z.number().int().min(0).max(100),
  conversionStatus:z.string().max(80),error:z.string().max(120).optional(),
  protectors:z.array(z.object({keyId:z.string().uuid(),cipher:z.string().regex(/^[A-Za-z0-9+/]{512}$/)}).strict()).max(16)
 }).strict()).max(32)
}).strict().superRefine((r,ctx)=>{
 if(new Set(r.volumes.map(v=>v.volumeId)).size!==r.volumes.length)ctx.addIssue({code:"custom",message:"Duplicate volume"});
 for(const v of r.volumes)if(new Set(v.protectors.map(k=>k.keyId)).size!==v.protectors.length)ctx.addIssue({code:"custom",message:"Duplicate protector"});
 if(r.volumes.reduce((n,v)=>n+v.protectors.length,0)>64)ctx.addIssue({code:"custom",message:"Too many keys"});
 if(Date.parse(r.collectedAt)>Date.now()+300000)ctx.addIssue({code:"custom",message:"Future report"});
});
export type AgentReport=z.infer<typeof reportSchema>;
export type AgentRow={id:string;owner:string;tenant:string;name:string;token_hash:string;public_key:string;private_key:string;machine_id:string|null;revoked:number;collected_at:string|null};
export function reply(data:unknown,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
export async function readJson(request:Request,max=100000){
 if(!request.headers.get("content-type")?.startsWith("application/json"))throw Error("INPUT");
 const reader=request.body?.getReader();if(!reader)throw Error("INPUT");let size=0;const chunks:Uint8Array[]=[];
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error("INPUT")}chunks.push(value)}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 return JSON.parse(new TextDecoder().decode(bytes));
}

