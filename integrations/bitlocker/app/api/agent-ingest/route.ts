import {database,tokenHash} from "@/lib/storage";
import {reportSchema,readJson,reply,type AgentRow} from "@/lib/agent-contract";
import {ingest} from "@/lib/agent-ingest";
export async function POST(request:Request){
 try{
 // Machine credentials only; cookies and browser identity never authorize ingestion.
 if(request.headers.has("origin"))return reply({error:"Browser uploads use the signed-in import flow"},403);
 const authorization=request.headers.get("authorization")||"";
 if(!/^Bearer [a-f0-9]{64}$/.test(authorization))return reply({error:"Agent credential required"},401);
 const agent=await database().prepare("SELECT * FROM agents WHERE token_hash=? AND revoked=0").bind(await tokenHash(authorization.slice(7))).first<AgentRow>();
 if(!agent)return reply({error:"Agent credential rejected"},401);
 const parsed=reportSchema.safeParse(await readJson(request));if(!parsed.success)return reply({error:"Invalid report"},400);
 if(parsed.data.agentId!==agent.id)return reply({error:"Wrong enrollment"},403);
 return reply(await ingest(agent,parsed.data));
 }catch(e){const code=(e as Error).message;if(code==="MACHINE"||code==="REVOKED")return reply({error:"Agent enrollment rejected"},403);if(code==="INPUT"||e instanceof SyntaxError)return reply({error:"Invalid or oversized report"},400);console.error("Agent ingestion failed");return reply({error:"Ingestion unavailable"},503)}
}
