import {env} from "cloudflare:workers";
export function database(){if(!env.DB)throw Error("Storage unavailable");return env.DB}
export function log(db:D1Database,owner:string,action:string,detail:string){return db.prepare("INSERT INTO audit (id,owner,action,detail,time) VALUES (?,?,?,?,?)").bind(crypto.randomUUID(),owner,action,detail,Date.now())}
export async function tokenHash(token:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token)))).map(v=>v.toString(16).padStart(2,"0")).join("")}
