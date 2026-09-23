"use client";
import {useState,useEffect,useRef} from "react";
import {ShieldCheck,LockKeyhole,Copy} from "lucide-react";
import {decrypt} from "@/lib/crypto";
export default function Recover(){
const token=useRef(""); const [pass,setPass]=useState(""),[cipher,setCipher]=useState(""),[key,setKey]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[copied,setCopied]=useState(false);
useEffect(()=>{token.current=location.hash.slice(1);history.replaceState(null,"",location.pathname)},[]);
useEffect(()=>{if(!key)return;const t=setTimeout(()=>{setKey("");setCipher("");setPass("");setError("Recovery key hidden. Request a new link if needed.")},60000);return()=>clearTimeout(t)},[key]);
async function open(e:React.FormEvent){e.preventDefault();setError("");setBusy(true);try{let encrypted=cipher;if(!encrypted){const r=await fetch("/api/vault",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"consume",token:token.current})});const j=await r.json() as {error:string;cipher:string};if(!r.ok)throw Error(j.error);encrypted=j.cipher;setCipher(encrypted)}try{setKey(await decrypt(encrypted,pass));setPass("")}catch{throw Error("Incorrect passphrase. You can retry while this page stays open.")}}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
return <main className="recover-page"><ShieldCheck size={34} color="#087967"/><h1 style={{marginTop:20}}>Secure recovery</h1><p className="muted">One-use access to your device’s BitLocker recovery key.</p><div className="security-note" style={{marginTop:24}}><LockKeyhole/>Opening consumes this link. Keep this page open until you have recovered your device. The key hides after 60 seconds.</div>{key?<div className="key-box" style={{marginTop:20}}><code>{key}</code><button onClick={async()=>{try{await navigator.clipboard.writeText(key);setCopied(true)}catch{setError("Clipboard unavailable. Select and copy the key manually.")}}}><Copy size={16}/>{copied?"Copied — clear your clipboard after use":"Copy recovery key"}</button></div>:<form className="form-stack" onSubmit={open}><label>Sharing passphrase<input required type="password" value={pass} onChange={e=>setPass(e.target.value)} autoComplete="off"/></label><button className="primary" disabled={busy}>{busy?"Unlocking…":"Open recovery key"}</button></form>}{error&&<p role="alert" style={{color:"#b42318",marginTop:16}}>{error}</p>}<p className="muted" style={{marginTop:22}}>Get the passphrase from your IT provider through a separate trusted channel.</p></main>
}


