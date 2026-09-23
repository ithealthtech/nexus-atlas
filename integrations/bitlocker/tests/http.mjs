import http from "node:http";
export function localPost(url,headers,body){
 const target=new URL(url);
 if(target.protocol!=="http:"||!["127.0.0.1","localhost"].includes(target.hostname))throw Error("Test requests must target a local HTTP worker");
 const data=JSON.stringify(body);
 return new Promise((resolve,reject)=>{
  const req=http.request(target,{method:"POST",agent:false,headers:{...headers,"Content-Length":Buffer.byteLength(data),"Connection":"close"}},res=>{
   let text="";res.setEncoding("utf8");res.on("data",c=>text+=c);res.on("end",()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)})}catch{reject(Error("Local worker returned non-JSON HTTP "+res.statusCode))}});
  });req.on("error",reject);req.setTimeout(15000,()=>req.destroy(Error("Test request timeout")));req.end(data);
 });
}
