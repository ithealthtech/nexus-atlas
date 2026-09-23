const encode=(v:Uint8Array)=>btoa(String.fromCharCode(...v));
const decode=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
async function derive(pass:string,salt:Uint8Array){const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);return crypto.subtle.deriveKey({name:"PBKDF2",salt:salt as BufferSource,iterations:600000,hash:"SHA-256"},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"])}
export async function encrypt(value:string,pass:string){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));const key=await derive(pass,salt);const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,new TextEncoder().encode(value));return JSON.stringify({v:1,salt:encode(salt),iv:encode(iv),data:encode(new Uint8Array(data))})}
export async function decrypt(cipher:string,pass:string,wrappedPrivate?:string):Promise<string>{
 const c=JSON.parse(cipher);
 if(c.v===2){
  if(!wrappedPrivate||c.algorithm!=="RSA-OAEP-256")throw Error("Missing collector private key");
  const privateBytes=decode(await decrypt(wrappedPrivate,pass));
  try{const key=await crypto.subtle.importKey("pkcs8",privateBytes,{name:"RSA-OAEP",hash:"SHA-256"},false,["decrypt"]);return new TextDecoder().decode(await crypto.subtle.decrypt({name:"RSA-OAEP"},key,decode(c.data)))}finally{privateBytes.fill(0)}
 }
 if(c.v!==1)throw Error("Unsupported encrypted record");
 const key=await derive(pass,decode(c.salt));return new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(c.iv)},key,decode(c.data)));
}
export async function generateAgentKeys(pass:string){
 if(pass.length<16)throw Error("Use an enrollment passphrase of at least 16 characters");
 const pair=await crypto.subtle.generateKey({name:"RSA-OAEP",modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:"SHA-256"},true,["encrypt","decrypt"]);
 const privateBytes=new Uint8Array(await crypto.subtle.exportKey("pkcs8",pair.privateKey));
 try{return {publicKey:encode(new Uint8Array(await crypto.subtle.exportKey("spki",pair.publicKey))),privateKey:await encrypt(encode(privateBytes),pass)}}finally{privateBytes.fill(0)}
}
