import {database,log,tokenHash} from "@/lib/storage";
import type {AgentReport,AgentRow} from "@/lib/agent-contract";
// A batch is one transaction. Every write rechecks revocation, identity binding,
// report freshness and replay state in SQL, avoiding a check-then-write race.
export async function ingest(agent:AgentRow,report:AgentReport){
 const db=database(),time=new Date().toISOString(),reportId=await tokenHash(agent.id+":"+report.reportId);
 const gate="id=? AND revoked=0 AND (machine_id IS NULL OR machine_id=?) AND (collected_at IS NULL OR collected_at<?) AND NOT EXISTS (SELECT 1 FROM agent_reports WHERE id=?)";
 const args=[agent.id,report.machineId,report.collectedAt,reportId];
 const snapshot=JSON.stringify({...report,volumes:report.volumes.map(v=>({...v,protectors:v.protectors.map(k=>({keyId:k.keyId}))}))});
 const statements:D1PreparedStatement[]=[];
 for(const volume of report.volumes)for(const key of volume.protectors){
  const id=await tokenHash(agent.id+":"+volume.volumeId+":"+key.keyId);
  const cipher=JSON.stringify({v:2,algorithm:"RSA-OAEP-256",data:key.cipher});
  statements.push(db.prepare(`INSERT INTO devices (id,owner,tenant,name,user,key_id,cipher,updated,agent_id,volume_id,protection,collected_at)
   SELECT ?,owner,tenant,?,'',?,?,?,id,?,?,? FROM agents WHERE ${gate}
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,cipher=excluded.cipher,updated=excluded.updated,protection=excluded.protection,collected_at=excluded.collected_at`)
   .bind(id,report.hostname+" / "+(volume.mountPoint||volume.volumeId),key.keyId,cipher,time,volume.volumeId,volume.protection,report.collectedAt,...args));
 }
 statements.push(db.prepare(`INSERT INTO audit (id,owner,action,detail,time) SELECT ?,owner,'Agent report received',?,? FROM agents WHERE ${gate}`).bind(crypto.randomUUID(),agent.tenant+" / "+report.hostname,Date.now(),...args));
 statements.push(db.prepare(`UPDATE agents SET machine_id=?,last_seen=?,snapshot=? WHERE ${gate} RETURNING id`).bind(report.machineId,time,snapshot,...args));
 statements.push(db.prepare(`INSERT INTO agent_reports (id,agent_id,received_at) SELECT ?,id,? FROM agents WHERE ${gate}`).bind(reportId,time,...args));
 // The report marker was inserted above, so final timestamp uses its presence.
 statements.push(db.prepare("UPDATE agents SET collected_at=? WHERE id=? AND machine_id=? AND revoked=0 AND (collected_at IS NULL OR collected_at<?) AND EXISTS (SELECT 1 FROM agent_reports WHERE id=?)").bind(report.collectedAt,agent.id,report.machineId,report.collectedAt,reportId));
 const results=await db.batch(statements);
 const accepted=results[results.length-3].results.length>0;
 if(accepted)return {accepted:true,keys:report.volumes.reduce((n,v)=>n+v.protectors.length,0)};
 const fresh=await db.prepare("SELECT revoked,machine_id FROM agents WHERE id=?").bind(agent.id).first<{revoked:number;machine_id:string}>();
 if(fresh?.revoked)throw Error("REVOKED");
 if(fresh?.machine_id&&fresh.machine_id!==report.machineId)throw Error("MACHINE");
 const duplicate=await db.prepare("SELECT id FROM agent_reports WHERE id=?").bind(reportId).first();
 return {accepted:false,duplicate:!!duplicate,stale:!duplicate};
}
export {log};
